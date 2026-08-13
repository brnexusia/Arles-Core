import { getCompanyByInstance, companyCanUseEngine } from './company.repository.js';
import { logIncoming, logOutgoing } from './message.repository.js';
import {
  bufferTextMessage,
  consumeSystemSending,
  isConversationPaused,
  markSystemSending,
  onceMessage,
  pauseConversation,
  scheduleFollowup,
  setLastInbound,
  withConversationLock
} from '../infrastructure/redis.js';
import { evolution } from '../whatsapp/evolution.client.js';
import { isMessageUpsert, normalizeEvolutionMessage } from '../whatsapp/normalize.js';
import { getVerticalModule } from '../verticals/router.js';
import type { OutgoingAction, VerticalModule, VerticalResult } from '../verticals/vertical.js';
import { mediaAiService } from '../media/media-ai.service.js';
import { env } from '../config/env.js';
import type { Company, NormalizedMessage } from './types.js';

export class ArlesEngine {
  private async sendActions(company: Company, message: NormalizedMessage, actions: OutgoingAction[]): Promise<void> {
    for (const action of actions) {
      await markSystemSending(company.id, message.phone);

      if (action.type === 'text') {
        await evolution.sendText({
          instanceName: company.evolution_instance,
          to: message.replyJid || message.phone,
          text: action.text
        });
        await logOutgoing({ companyId: company.id, phone: message.phone, body: action.text });
      } else {
        await evolution.sendImage({
          instanceName: company.evolution_instance,
          to: message.replyJid || message.phone,
          mediaUrl: action.mediaUrl,
          caption: action.caption,
          fileName: action.fileName
        });
        await logOutgoing({
          companyId: company.id,
          phone: message.phone,
          body: action.caption ? `[Imagem] ${action.caption}` : '[Imagem enviada]'
        });
      }
    }
  }

  private async applyResult(
    company: Company,
    message: NormalizedMessage,
    result: VerticalResult
  ): Promise<void> {
    if (result.pauseSeconds) {
      await pauseConversation(company.id, message.phone, result.pauseSeconds);
    }
    if (result.actions.length) await this.sendActions(company, message, result.actions);
    if (result.followup) {
      await scheduleFollowup({
        companyId: company.id,
        phone: message.phone,
        instanceName: company.evolution_instance,
        replyJid: message.replyJid || message.phone,
        sourceMessageId: message.messageId,
        text: result.followup.text
      }, result.followup.delaySeconds);
    }
  }

  private async processImage(
    company: Company,
    message: NormalizedMessage,
    module: VerticalModule
  ): Promise<{ text?: string; result?: VerticalResult }> {
    try {
      const media = await evolution.getMediaBase64({
        instanceName: company.evolution_instance,
        messageId: message.messageId
      });

      const analysis = await mediaAiService.analyzeImage(
        media.base64,
        media.mimeType
      );

      if (module.handleImage) {
        const result = await module.handleImage(
          { company, message, combinedText: '' },
          { ...media, ...analysis }
        );
        if (result) return { result };
      }

      return { text: `[Imagem enviada pelo cliente]\n${analysis.description}` };
    } catch (error) {
      console.error('[Arles] falha processando imagem:', error);

      await this.sendActions(company, message, [{
        type: 'text',
        text:
          'Não consegui analisar essa imagem agora. Pode tentar enviar novamente ou me explicar em texto? 😊'
      }]);

      return {};
    }
  }

  private async processAudio(
    company: Company,
    message: NormalizedMessage
  ): Promise<string | null> {
    try {
      const media = await evolution.getMediaBase64({
        instanceName: company.evolution_instance,
        messageId: message.messageId
      });

      const text = await mediaAiService.transcribeAudio(
        media.base64,
        media.mimeType || 'audio/ogg'
      );

      if (!text) {
        await this.sendActions(company, message, [{
          type: 'text',
          text: 'Não consegui entender o áudio. Pode me mandar em texto? 😊'
        }]);
        return null;
      }

      return `[Áudio transcrito]\n${text}`;
    } catch (error) {
      console.error('[Arles] falha processando áudio:', error);

      await this.sendActions(company, message, [{
        type: 'text',
        text: 'Não consegui entender o áudio. Pode me mandar em texto? 😊'
      }]);

      return null;
    }
  }

  async handleEvolution(payload: unknown): Promise<void> {
    const message = normalizeEvolutionMessage(payload);

    if (!message.instanceName || !message.remoteJid || !message.phone) return;
    if (message.isGroup || message.isBroadcast) return;
    if (message.event && !isMessageUpsert(message.event)) return;

    const company = await getCompanyByInstance(message.instanceName);
    if (!company) {
      console.warn(`[Arles] Instância sem empresa: ${message.instanceName}`);
      return;
    }

    const module = getVerticalModule(company.vertical);
    if (!module) {
      console.warn(`[Arles] Vertical sem módulo registrado: ${company.vertical}`);
      return;
    }

    // Mensagem escrita manualmente pela loja pausa a IA por 1h.
    // Mensagens enviadas pelo próprio Arles possuem marcador curto e são ignoradas.
    if (message.fromMe) {
      const wasSystem = await consumeSystemSending(company.id, message.phone);
      if (!wasSystem) {
        await pauseConversation(company.id, message.phone, env.humanPauseSeconds);
      }
      return;
    }

    if (!companyCanUseEngine(company)) return;
    if (!(await onceMessage(company.id, message.messageId))) return;

    await logIncoming({
      companyId: company.id,
      phone: message.phone,
      messageId: message.messageId,
      messageType: message.type,
      body: message.text,
      rawPayload: payload
    });
    await setLastInbound(company.id, message.phone, message.messageId);

    if (await isConversationPaused(company.id, message.phone)) return;

    let messageText: string | null = null;

    if (message.type === 'text') {
      messageText = message.text;
    } else if (message.type === 'image') {
      const image = await this.processImage(company, message, module);
      if (image.result) {
        await this.applyResult(company, message, image.result);
        return;
      }
      messageText = image.text ?? null;
    } else if (message.type === 'audio') {
      messageText = await this.processAudio(company, message);
    } else {
      console.info(`[Arles] Tipo não suportado: ${message.type}`);
      return;
    }

    if (!messageText) return;

    const combinedText = await bufferTextMessage({
      companyId: company.id,
      phone: message.phone,
      messageId: message.messageId,
      text: messageText
    });
    if (!combinedText) return;

    if (module.handlePendingInteraction) {
      const intercepted = await module.handlePendingInteraction({ company, message, combinedText });
      if (intercepted) {
        await this.applyResult(company, message, intercepted);
        return;
      }
    }

    const result = await withConversationLock(company.id, message.phone, async () => {
      return module.handle({ company, message, combinedText });
    });

    if (!result) return;

    await this.applyResult(company, message, result as VerticalResult);
  }
}

export const arlesEngine = new ArlesEngine();
