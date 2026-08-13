import { evolution } from '../../whatsapp/evolution.client.js';
import {
  markSystemSending,
  resumeConversation
} from '../../infrastructure/redis.js';
import { updateOrderStatus } from './repository.js';
import { logOutgoing } from '../../core/message.repository.js';
import { deliveryConfig } from './config.js';
import { markStatusSent, setAwaitingReview, statusAlreadySent } from './state.js';

export type CanonicalOrderStatus =
  | 'Novos'
  | 'Em preparo'
  | 'Pronto'
  | 'Saiu para entrega'
  | 'Finalizados'
  | 'Cancelados';

export function normalizeOrderStatus(raw: string): CanonicalOrderStatus | null {
  const s = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

  if (/^(novo|novos|new)$/.test(s)) return 'Novos';
  if (/^(em preparo|preparando|preparo|em preparacao|em preparação)$/.test(s)) return 'Em preparo';
  if (/^(pronto|pronta|finalizado para retirada|finalizado para entrega)$/.test(s)) return 'Pronto';
  if (/^(saiu para entrega|saiu|em entrega|a caminho)$/.test(s)) return 'Saiu para entrega';
  if (/^(finalizado|finalizados|entregue|entregues|concluido|concluído)$/.test(s)) return 'Finalizados';
  if (/^(cancelado|cancelados|cancelada|canceladas)$/.test(s)) return 'Cancelados';
  return null;
}

function statusMessage(status: CanonicalOrderStatus): string {
  switch (status) {
    case 'Em preparo':
      return '👨‍🍳 Seu pedido já está em preparo!';
    case 'Pronto':
      return '✅ Seu pedido está pronto!';
    case 'Saiu para entrega':
      return '🛵 Seu pedido saiu para entrega! Já já chega por aí.';
    case 'Finalizados':
      return '✅ Pedido entregue! 😊 De 1 a 5, que nota você dá para seu pedido?';
    case 'Cancelados':
      return 'Seu pedido foi cancelado. Se precisar de ajuda, fala com a gente por aqui.';
    default:
      return '';
  }
}

export class DeliveryPostSaleService {
  async updateAndNotify(input: {
    companyId: string;
    orderId: string;
    status: string;
  }): Promise<{ changed: boolean; notified: boolean; status: CanonicalOrderStatus }> {
    const status = normalizeOrderStatus(input.status);
    if (!status) throw new Error(`Status não reconhecido: ${input.status}`);

    const context = await updateOrderStatus({
      companyId: input.companyId,
      orderId: input.orderId,
      status
    });

    if (!context) throw new Error('Pedido não encontrado para a empresa informada.');

    const changed = context.previousStatus !== status;
    const message = statusMessage(status);
    if (!message) return { changed, notified: false, status };

    if (await statusAlreadySent(context.orderId, status)) {
      return { changed, notified: false, status };
    }

    await markSystemSending(context.companyId, context.clientPhone);
    await evolution.sendText({
      instanceName: context.instanceName,
      to: context.clientPhone,
      text: message
    });
    await logOutgoing({
      companyId: context.companyId,
      phone: context.clientPhone,
      body: message
    });
    await markStatusSent(context.orderId, status);

    if (status === 'Finalizados') {
      await resumeConversation(context.companyId, context.clientPhone);
      await setAwaitingReview(context.companyId, context.clientPhone, {
        orderId: context.orderId,
        customerId: context.customerId,
        clientName: context.clientName,
        companyName: context.companyName,
        companyInstagram: context.companyInstagram
      }, deliveryConfig.reviewTtlSeconds);
    }

    return { changed, notified: true, status };
  }
}

export const deliveryPostSaleService = new DeliveryPostSaleService();
