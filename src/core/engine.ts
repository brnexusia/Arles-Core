import { getCompanyByInstance, companyCanUseEngine } from './company.repository.js';
import { logIncoming, logOutgoing } from './message.repository.js';
import {
  bufferTextMessage,
  consumeSystemSending,
  isConversationPaused,
  markSystemSending,
  onceMessage,
  pauseConversation,
  setLastInbound,
  withConversationLock
} from '../infrastructure/redis.js';
import { evolution } from '../whatsapp/evolution.client.js';
import { isMessageUpsert, normalizeEvolutionMessage } from '../whatsapp/normalize.js';
import { moduleRegistry } from '../platform/modules/registry.js';
import type { OutgoingAction, VerticalModule, VerticalResult } from '../platform/modules/contract.js';
import { platformJobService } from '../platform/jobs/job.service.js';
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
          caption: action.caption
        });
        await logOutgoing({
          companyId: company.id,
          phone: message.phone,
          body: action.caption ? `[Imagem] ${action.caption}` : '[Imagem enviada]'
        });
      }
    }
  }

  private async processImage(
    company: Company,
    message: NormalizedMessage,
    module: VerticalModule
  ): Promise<string | null> {
    try {
      const media = await evolution.getMediaBase64({
        instanceName: company.evolution_instance,
        messageId: message.messageId
      });

      if (module.media?.handleImage) {
        const result = await module.media.handleImage({ company, message, media });
        if (result.actions?.length) {
          await this.sendActions(company, message, result.actions);
        }
        if (result.consumed) return null;
        if (result.messageText) return result.messageText;
      }

      const analysis = await mediaAiService.analyzeImage(media.base64, media.mimeType);
      return `[Imagem enviada pelo cliente]\n${analysis.description}`;
    } catch (error) {
      console.error('[Arles] falha processando imagem:', error);

      await this.sendActions(company, message, [{
        type: 'text',
        text:
          'Não consegui analisar essa imagem agora. Pode tentar enviar novamente ou me explicar em texto? 😊'
      }]);

      return null;
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

    const module = moduleRegistry.resolveForCompany(company);
    if (!module?.conversationHandler) {
      console.warn(`[Arles] Módulo sem handler para o tenant: ${company.vertical}`);
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
      messageText = await this.processImage(company, message, module);
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

    const intercepted = await module.beforeConversation?.({
      company,
      message,
      combinedText
    });
    if (intercepted) {
      if (intercepted.pauseSeconds) {
        await pauseConversation(company.id, message.phone, intercepted.pauseSeconds);
      }
      if (intercepted.actions.length) {
        await this.sendActions(company, message, intercepted.actions);
      }
      return;
    }

    const result = await withConversationLock(company.id, message.phone, async () => {
      return module.conversationHandler!.handle({ company, message, combinedText });
    });

    if (!result) return;

    const verticalResult = result as VerticalResult;
    if (verticalResult.pauseSeconds) {
      await pauseConversation(company.id, message.phone, verticalResult.pauseSeconds);
    }

    if (verticalResult.actions.length) {
      await this.sendActions(company, message, verticalResult.actions);
    }

    if (verticalResult.followupEligible && module.createFollowup) {
      const followup = await module.createFollowup(
        { company, message, combinedText },
        verticalResult
      );
      if (followup) {
        await platformJobService.enqueue({
          companyId: company.id,
          moduleKey: module.key,
          type: followup.type,
          runAt: followup.runAt,
          payload: followup.payload,
          idempotencyKey: followup.idempotencyKey
        });
      }
    }
  }
}

export const arlesEngine = new ArlesEngine();
