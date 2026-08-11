import { getCompanyByInstance, companyCanUseEngine } from './company.repository.js';
import { logIncoming, logOutgoing } from './message.repository.js';
import {
  bufferTextMessage,
  clearAwaitingReview,
  consumeSystemSending,
  getAwaitingReview,
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
import { getVerticalHandler } from '../verticals/router.js';
import type { OutgoingAction, VerticalResult } from '../verticals/vertical.js';
import { mediaAiService } from '../media/media-ai.service.js';
import {
  getPendingPixOrder,
  registerReview,
  savePixProof
} from '../verticals/delivery/repository.js';
import { parseRating } from '../verticals/delivery/helpers.js';
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

  private async handleReviewIfPending(company: Company, message: NormalizedMessage, text: string): Promise<boolean> {
    const pending = await getAwaitingReview(company.id, message.phone);
    if (!pending) return false;

    const rating = parseRating(text);
    if (!rating) return false;

    await registerReview({
      companyId: company.id,
      orderId: pending.orderId,
      customerName: pending.clientName,
      phone: message.phone,
      rating
    });
    await clearAwaitingReview(company.id, message.phone);

    let instagram = pending.companyInstagram.trim()
      .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
      .replace(/\/.*$/, '')
      .replace(/^@/, '');

    const response = rating >= 4
      ? `Aee! 💙 Obrigado pela nota ${rating}/5. Se postar seu pedido, marca ${instagram ? `@${instagram}` : pending.companyName || 'a gente'} e @arlesdelivery pra gente ver 😄`
      : `Obrigado pela nota ${rating}/5 💙 Seu feedback ajuda a gente a melhorar.`;

    await this.sendActions(company, message, [{ type: 'text', text: response }]);
    return true;
  }

  private async processImage(
    company: Company,
    message: NormalizedMessage
  ): Promise<string | null> {
    try {
      const media = await evolution.getMediaBase64({
        instanceName: company.evolution_instance,
        messageId: message.messageId
      });

      const pendingPix = await getPendingPixOrder(
        company.id,
        message.phone
      );

      const analysis = await mediaAiService.analyzeImage(
        media.base64,
        media.mimeType
      );

      if (pendingPix) {
        if (!analysis.looksLikePixProof) {
          await this.sendActions(company, message, [{
            type: 'text',
            text:
              'Recebi a imagem, mas não consegui identificar um comprovante de Pix. Pode me enviar uma foto ou print do comprovante? 😊'
          }]);
          return null;
        }

        await savePixProof({
          companyId: company.id,
          orderId: pendingPix.id,
          expectedPaymentStatus: pendingPix.payment_status,
          mimeType: media.mimeType.startsWith('image/')
            ? media.mimeType
            : 'image/jpeg',
          bytes: Buffer.from(media.base64, 'base64')
        });

        await this.sendActions(company, message, [{
          type: 'text',
          text:
            `Recebi seu comprovante 😊 Ele foi anexado somente ao pedido #${pendingPix.id
              .slice(0, 4)
              .toUpperCase()} e está aguardando a conferência da equipe.`
        }]);

        return null;
      }

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
      messageText = await this.processImage(company, message);
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

    if (await this.handleReviewIfPending(company, message, combinedText)) return;

    const result = await withConversationLock(company.id, message.phone, async () => {
      const handler = getVerticalHandler(company.vertical);
      if (!handler) {
        console.warn(`[Arles] Vertical ainda sem handler: ${company.vertical}`);
        return null;
      }
      return handler.handle({ company, message, combinedText });
    });

    if (!result) return;

    const verticalResult = result as VerticalResult;
    if (verticalResult.pauseSeconds) {
      await pauseConversation(company.id, message.phone, verticalResult.pauseSeconds);
    }

    if (verticalResult.actions.length) {
      await this.sendActions(company, message, verticalResult.actions);
    }

    if (verticalResult.followupEligible) {
      await scheduleFollowup({
        companyId: company.id,
        phone: message.phone,
        instanceName: company.evolution_instance,
        replyJid: message.replyJid || message.phone,
        sourceMessageId: message.messageId,
        text: 'Oi 😊 Quer confirmar seu pedido?'
      });
    }
  }
}

export const arlesEngine = new ArlesEngine();
