import { getCompanyByInstance, getOrCreateCashCompanyByOwnerPhone, companyCanUseEngine } from './company.repository.js';
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
  private isCashSharedInstance(instanceName: string): boolean {
    return Boolean(env.cashEvolutionInstance && instanceName === env.cashEvolutionInstance);
  }

  private outboundInstance(company: Company, message?: NormalizedMessage): string {
    if (company.vertical === 'cash' && env.cashEvolutionInstance) {
      return env.cashEvolutionInstance;
    }
    return message?.instanceName || company.evolution_instance;
  }

  private async resolveCompany(message: NormalizedMessage): Promise<{
    company: Company | null;
    cashShared: boolean;
    route: 'instance' | 'cash-shared' | 'none';
  }> {
    // Delivery e outras verticais sempre têm prioridade pela própria instância.
    const instanceCompany = await getCompanyByInstance(message.instanceName);
    if (instanceCompany && instanceCompany.vertical !== 'cash') {
      return { company: instanceCompany, cashShared: false, route: 'instance' };
    }

    const cashShared = this.isCashSharedInstance(message.instanceName);
    if (cashShared) {
      // WhatsApp-first: um número remetente é uma conta. Se for o primeiro contato,
      // a conta e o trial são criados automaticamente, sem cadastro/painel.
      const cashAccount = await getOrCreateCashCompanyByOwnerPhone(message.phone);
      return {
        company: cashAccount.company,
        cashShared: true,
        route: 'cash-shared'
      };
    }

    return {
      company: instanceCompany,
      cashShared: false,
      route: instanceCompany ? 'instance' : 'none'
    };
  }

  private async sendActions(company: Company, message: NormalizedMessage, actions: OutgoingAction[]): Promise<void> {
    for (const action of actions) {
      await markSystemSending(company.id, message.phone);

      if (action.type === 'text') {
        await evolution.sendText({
          instanceName: this.outboundInstance(company, message),
          to: message.replyJid || message.phone,
          text: action.text
        });
        await logOutgoing({ companyId: company.id, phone: message.phone, body: action.text });
      } else {
        await evolution.sendImage({
          instanceName: this.outboundInstance(company, message),
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
        instanceName: this.outboundInstance(company, message),
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
        instanceName: this.outboundInstance(company, message),
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
        instanceName: this.outboundInstance(company, message),
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
    const phoneTail = message.phone ? message.phone.slice(-4) : '----';

    if (!message.instanceName || !message.remoteJid || !message.phone) {
      console.warn('[Arles] Webhook Evolution descartado: payload sem instanceName/remoteJid/phone.');
      return;
    }
    if (message.isGroup || message.isBroadcast) {
      console.info(`[Arles] Webhook ignorado: grupo/broadcast instance=${message.instanceName} phone=*${phoneTail}`);
      return;
    }
    if (message.event && !isMessageUpsert(message.event)) {
      console.info(`[Arles] Webhook ignorado: event=${message.event} instance=${message.instanceName} phone=*${phoneTail}`);
      return;
    }

    const resolved = await this.resolveCompany(message);
    const company = resolved.company;

    if (!company) {
      console.warn(`[Arles] Instância sem empresa: ${message.instanceName}`);
      return;
    }

    console.info(
      `[Arles] Webhook roteado: instance=${message.instanceName} route=${resolved.route} vertical=${company.vertical} event=${message.event || 'sem_evento'} type=${message.type} phone=*${phoneTail}`
    );

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
        console.info(`[Arles] Conversa pausada por mensagem humana: company=${company.id} phone=*${phoneTail}`);
        await pauseConversation(company.id, message.phone, env.humanPauseSeconds);
      }
      return;
    }

    // Cash precisa receber a mensagem mesmo expirado para conseguir mostrar o paywall
    // e permitir reativação. As outras verticais mantêm o bloqueio global normal.
    if (!companyCanUseEngine(company) && company.vertical !== 'cash') {
      console.warn(
        `[Arles] Engine bloqueado para company=${company.id} vertical=${company.vertical} access_active=${company.access_active} subscription_status=${company.subscription_status}`
      );
      return;
    }
    if (!(await onceMessage(company.id, message.messageId))) {
      console.info(`[Arles] Mensagem duplicada ignorada: company=${company.id} messageId=${message.messageId}`);
      return;
    }

    await logIncoming({
      companyId: company.id,
      phone: message.phone,
      messageId: message.messageId,
      messageType: message.type,
      body: message.text,
      rawPayload: payload
    });
    await setLastInbound(company.id, message.phone, message.messageId);

    if (await isConversationPaused(company.id, message.phone)) {
      console.info(`[Arles] Mensagem recebida com conversa pausada: company=${company.id} phone=*${phoneTail}`);
      return;
    }

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

    if (!messageText) {
      console.info(`[Arles] Mensagem sem conteúdo processável: company=${company.id} type=${message.type}`);
      return;
    }

    const combinedText = await bufferTextMessage({
      companyId: company.id,
      phone: message.phone,
      messageId: message.messageId,
      text: messageText
    });
    if (!combinedText) {
      console.info(`[Arles] Buffer aguardando/consumido por outra mensagem: company=${company.id} phone=*${phoneTail}`);
      return;
    }

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

    if (!result) {
      console.info(`[Arles] Lock ocupado/sem resultado: company=${company.id} phone=*${phoneTail}`);
      return;
    }

    await this.applyResult(company, message, result as VerticalResult);
  }
}

export const arlesEngine = new ArlesEngine();
