import { clearAwaitingReview, getAwaitingReview } from './state.js';
import type { VerticalContext, VerticalMedia, VerticalResult } from '../vertical.js';
import { parseRating } from './helpers.js';
import {
  getPendingPixOrder,
  registerReview,
  savePixProof
} from './repository.js';

export async function handleDeliveryPendingInteraction(
  context: VerticalContext
): Promise<VerticalResult | undefined> {
  const { company, message, combinedText } = context;
  const pending = await getAwaitingReview(company.id, message.phone);
  if (!pending) return undefined;

  const rating = parseRating(combinedText);
  if (!rating) return undefined;

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

  const text = rating >= 4
    ? `Aee! 💙 Obrigado pela nota ${rating}/5. Se postar seu pedido, marca ${instagram ? `@${instagram}` : pending.companyName || 'a gente'} e @arlesdelivery pra gente ver 😄`
    : `Obrigado pela nota ${rating}/5 💙 Seu feedback ajuda a gente a melhorar.`;

  return { actions: [{ type: 'text', text }] };
}

export async function handleDeliveryImage(
  context: VerticalContext,
  media: VerticalMedia
): Promise<VerticalResult | undefined> {
  const { company, message } = context;
  const pendingPix = await getPendingPixOrder(company.id, message.phone);
  if (!pendingPix) return undefined;

  if (!media.looksLikePaymentProof) {
    return {
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
    actions: [{
      type: 'text',
      text: `Recebi seu comprovante 😊 Ele foi anexado somente ao pedido #${pendingPix.id.slice(0, 4).toUpperCase()} e está aguardando a conferência da equipe.`
    }]
  };
}
