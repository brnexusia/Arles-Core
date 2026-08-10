import { getCompanyByInstance, companyCanUseEngine } from './company.repository.js';
import { logIncoming, logOutgoing } from './message.repository.js';
import { bufferTextMessage, onceMessage, withConversationLock } from '../infrastructure/redis.js';
import { evolution } from '../whatsapp/evolution.client.js';
import { isMessageUpsert, normalizeEvolutionMessage } from '../whatsapp/normalize.js';
import { getVerticalHandler } from '../verticals/router.js';

export class ArlesEngine {
  async handleEvolution(payload: unknown): Promise<void> {
    const message = normalizeEvolutionMessage(payload);

    if (!message.instanceName) return;
    if (!message.remoteJid || !message.phone) return;
    if (message.fromMe || message.isGroup || message.isBroadcast) return;

    if (message.event && !isMessageUpsert(message.event)) {
      return;
    }

    const company = await getCompanyByInstance(message.instanceName);

    if (!company) {
      console.warn(
        `[Arles] Instância sem empresa: ${message.instanceName}`
      );
      return;
    }

    if (!companyCanUseEngine(company)) {
      return;
    }

    if (!(await onceMessage(company.id, message.messageId))) {
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

    if (message.type !== 'text') {
      console.info(
        `[Arles] ${message.type} recebido; mídia será portada na v0.2.`
      );
      return;
    }

    const combinedText = await bufferTextMessage({
      companyId: company.id,
      phone: message.phone,
      messageId: message.messageId,
      text: message.text
    });

    if (!combinedText) return;

    const response = await withConversationLock(
      company.id,
      message.phone,
      async () => {
        const handler = getVerticalHandler(company.vertical);

        if (!handler) {
          console.warn(
            `[Arles] Vertical ainda sem handler: ${company.vertical}`
          );
          return null;
        }

        return handler.handle({
          company,
          message,
          combinedText
        });
      }
    );

    if (!response) return;

    await evolution.sendText({
      instanceName: company.evolution_instance,
      to: message.replyJid || message.phone,
      text: response
    });

    await logOutgoing({
      companyId: company.id,
      phone: message.phone,
      body: response
    });
  }
}

export const arlesEngine = new ArlesEngine();
