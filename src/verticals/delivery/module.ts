import type { VerticalModule } from '../../platform/modules/contract.js';
import { deliveryHandler } from './handler.js';
import { deliveryConfig } from './config.js';
import {
  clearAwaitingReview,
  followupAlreadySent,
  getAwaitingReview,
  markFollowupSent
} from './state.js';
import {
  getPendingPixOrder,
  registerReview,
  savePixProof
} from './repository.js';
import { parseRating } from './helpers.js';
import { mediaAiService } from '../../media/media-ai.service.js';
import {
  getLastInbound,
  isConversationPaused,
  markSystemSending
} from '../../infrastructure/redis.js';
import { evolution } from '../../whatsapp/evolution.client.js';
import { logOutgoing } from '../../core/message.repository.js';
import { registerDeliveryRoutes } from './routes.js';

const PIX_IMAGE_INSTRUCTIONS = [
  'Analise a imagem enviada por um cliente.',
  'Na primeira linha responda exatamente PIX_COMPROVANTE: SIM se parecer comprovante ou recibo de Pix, transferência bancária ou pagamento concluído; caso contrário PIX_COMPROVANTE: NAO.',
  'Na segunda linha escreva DESCRICAO: e descreva objetivamente a imagem.',
  'Não afirme que o pagamento foi aprovado.'
].join(' ');

export const deliveryModule: VerticalModule = {
  key: 'delivery',
  metadata: {
    name: 'Arles Delivery',
    description: 'Atendimento conversacional e operação para estabelecimentos de alimentação.',
    version: '1.0.0',
    icon: 'utensils'
  },
  capabilities: [
    { key: 'vertical.delivery', required: true, description: 'Operação Delivery' }
  ],
  conversationHandler: deliveryHandler,
  media: {
    policies: {
      accepted: ['image/*', 'audio/*'],
      pixProofMaxAgeHours: deliveryConfig.pixProofMaxAgeHours
    },
    async handleImage({ company, message, media }) {
      const pendingPix = await getPendingPixOrder(company.id, message.phone);
      const analysis = await mediaAiService.analyzeImage(
        media.base64,
        media.mimeType,
        pendingPix ? PIX_IMAGE_INSTRUCTIONS : undefined
      );

      if (!pendingPix) {
        return {
          consumed: false,
          messageText: `[Imagem enviada pelo cliente]\n${analysis.description}`
        };
      }

      if (!/PIX_COMPROVANTE\s*:\s*SIM/i.test(analysis.rawText)) {
        return {
          consumed: true,
          actions: [{
            type: 'text',
            text: 'Recebi a imagem, mas não consegui identificar um comprovante de Pix. Pode me enviar uma foto ou print do comprovante? 😊'
          }]
        };
      }

      await savePixProof({
        companyId: company.id,
        orderId: pendingPix.id,
        expectedPaymentStatus: pendingPix.payment_status,
        mimeType: media.mimeType.startsWith('image/') ? media.mimeType : 'image/jpeg',
        bytes: Buffer.from(media.base64, 'base64')
      });

      return {
        consumed: true,
        actions: [{
          type: 'text',
          text: `Recebi seu comprovante 😊 Ele foi anexado somente ao pedido #${pendingPix.id.slice(0, 4).toUpperCase()} e está aguardando a conferência da equipe.`
        }]
      };
    }
  },
  async beforeConversation({ company, message, combinedText }) {
    const pending = await getAwaitingReview(company.id, message.phone);
    if (!pending) return null;

    const rating = parseRating(combinedText);
    if (!rating) return null;

    await registerReview({
      companyId: company.id,
      orderId: pending.orderId,
      customerName: pending.clientName,
      phone: message.phone,
      rating
    });
    await clearAwaitingReview(company.id, message.phone);

    const instagram = pending.companyInstagram.trim()
      .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
      .replace(/\/.*$/, '')
      .replace(/^@/, '');

    const response = rating >= 4
      ? `Aee! 💙 Obrigado pela nota ${rating}/5. Se postar seu pedido, marca ${instagram ? `@${instagram}` : pending.companyName || 'a gente'} e @arlesdelivery pra gente ver 😄`
      : `Obrigado pela nota ${rating}/5 💙 Seu feedback ajuda a gente a melhorar.`;

    return { actions: [{ type: 'text', text: response }] };
  },
  async createFollowup({ company, message }, result) {
    if (!result.followupEligible) return null;
    return {
      type: 'conversation-followup',
      runAt: new Date(Date.now() + deliveryConfig.followupDelaySeconds * 1000),
      idempotencyKey: `followup:${message.phone}:${message.messageId}`,
      payload: {
        phone: message.phone,
        instanceName: company.evolution_instance,
        replyJid: message.replyJid || message.phone,
        sourceMessageId: message.messageId,
        text: 'Oi 😊 Quer confirmar seu pedido?'
      }
    };
  },
  jobs: {
    async 'conversation-followup'(job) {
      const phone = String(job.payload.phone ?? '').replace(/\D/g, '');
      const sourceMessageId = String(job.payload.sourceMessageId ?? '');
      const instanceName = String(job.payload.instanceName ?? '');
      const replyJid = String(job.payload.replyJid ?? phone);
      const text = String(job.payload.text ?? '');
      if (!phone || !sourceMessageId || !instanceName || !text) {
        throw new Error('DELIVERY_FOLLOWUP_PAYLOAD_INVALID');
      }

      const [lastInbound, alreadySent, paused] = await Promise.all([
        getLastInbound(job.companyId, phone),
        followupAlreadySent(job.companyId, phone),
        isConversationPaused(job.companyId, phone)
      ]);
      if (alreadySent || paused || lastInbound !== sourceMessageId) return;

      await markSystemSending(job.companyId, phone);
      await evolution.sendText({ instanceName, to: replyJid, text });
      await logOutgoing({ companyId: job.companyId, phone, body: text });
      await markFollowupSent(job.companyId, phone);
    }
  },
  registerRoutes: registerDeliveryRoutes,
  events: ['delivery.order-status.changed', 'delivery.payment-status.changed'],
  onboardingSteps: [
    { key: 'delivery.store', scope: 'capability', capabilityKey: 'vertical.delivery', title: 'Informações da loja', order: 100 },
    { key: 'platform.whatsapp', scope: 'platform', title: 'Conectar WhatsApp', order: 200 }
  ],
  configuration: {
    followupDelaySeconds: deliveryConfig.followupDelaySeconds,
    pixProofMaxAgeHours: deliveryConfig.pixProofMaxAgeHours
  },
  ui: {
    entry: 'delivery',
    navigation: [
      { key: 'dashboard', label: 'Dashboard', icon: 'home', order: 10 },
      { key: 'orders', label: 'Pedidos', icon: 'package', order: 20 },
      { key: 'menu', label: 'Cardápio', icon: 'utensils', order: 30 },
      { key: 'customers', label: 'Clientes', icon: 'users', order: 40 },
      { key: 'settings', label: 'Ajustes', icon: 'settings', order: 50 }
    ]
  }
};
