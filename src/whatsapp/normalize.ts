import type { NormalizedMessage } from '../core/types.js';

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

export function normalizeEvolutionMessage(payload: any): NormalizedMessage {
  const body = payload?.body ?? payload ?? {};
  const data = body?.data ?? {};
  const key = data?.key ?? body?.key ?? {};
  const message = data?.message ?? body?.message ?? {};

  const event = String(body?.event ?? '')
    .toUpperCase()
    .replace(/[.\-]/g, '_');

  const instanceName = String(
    body?.instance_name ??
    body?.instance ??
    data?.instance ??
    ''
  ).trim();

  const rawJid = String(
    body?.phone ??
    key?.remoteJid ??
    data?.sender ??
    body?.sender ??
    ''
  ).trim();

  const altJid = String(
    key?.remoteJidAlt ??
    key?.participantAlt ??
    data?.senderPn ??
    data?.remoteJidAlt ??
    ''
  ).trim();

  let replyJid = rawJid;

  if (rawJid.includes('@lid') && altJid) {
    replyJid = altJid;
  }

  if (replyJid && !replyJid.includes('@') && /^\+?\d+$/.test(replyJid)) {
    replyJid = `${digits(replyJid)}@s.whatsapp.net`;
  }

  const phone = digits(replyJid || rawJid);

  const text = String(
    typeof body?.message === 'string'
      ? body.message
      : message?.conversation ??
        message?.extendedTextMessage?.text ??
        message?.imageMessage?.caption ??
        message?.videoMessage?.caption ??
        ''
  ).trim();

  let type: NormalizedMessage['type'] = 'unsupported';

  if (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    (text && !message?.imageMessage && !message?.audioMessage)
  ) {
    type = 'text';
  }

  if (message?.imageMessage) type = 'image';
  if (message?.audioMessage) type = 'audio';

  return {
    messageId: String(body?.message_id ?? key?.id ?? data?.id ?? ''),
    instanceName,
    remoteJid: rawJid,
    replyJid,
    phone,
    pushName: String(data?.pushName ?? body?.pushName ?? ''),
    fromMe: body?.from_me === true || key?.fromMe === true,
    isGroup: rawJid.endsWith('@g.us'),
    isBroadcast:
      rawJid.includes('@broadcast') ||
      rawJid.includes('status@broadcast'),
    event,
    type,
    text,
    raw: payload
  };
}

export function isMessageUpsert(event: string): boolean {
  return event === 'MESSAGES_UPSERT' || event === 'MESSAGE_UPSERT';
}
