import { describe, expect, it } from 'vitest';
import { isMessageUpsert, normalizeEvolutionMessage } from '../src/whatsapp/normalize.js';

describe('Evolution webhook', () => {
  it('normaliza evento, tenant instance, telefone e texto', () => {
    const message = normalizeEvolutionMessage({
      event: 'messages.upsert',
      instance: 'tenant-a-instance',
      data: {
        key: { id: 'msg-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
        message: { conversation: 'Olá' }
      }
    });
    expect(isMessageUpsert(message.event)).toBe(true);
    expect(message.instanceName).toBe('tenant-a-instance');
    expect(message.phone).toBe('5511999999999');
    expect(message.text).toBe('Olá');
  });

  it('marca grupos e broadcasts para descarte no kernel', () => {
    expect(normalizeEvolutionMessage({ data: { key: { remoteJid: '1@g.us' } } }).isGroup).toBe(true);
    expect(normalizeEvolutionMessage({ data: { key: { remoteJid: 'status@broadcast' } } }).isBroadcast).toBe(true);
  });
});
