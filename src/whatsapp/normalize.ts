import type { NormalizedMessage } from '../core/types.js';

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

function normalizedEvent(value: unknown): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[.\-]/g, '_');
}

function messageText(message: any): string {
  return String(
    message?.conversation ??
    message?.extendedTextMessage?.text ??
    message?.imageMessage?.caption ??
    message?.videoMessage?.caption ??
    message?.documentMessage?.caption ??
    ''
  ).trim();
}

function quotedTextFrom(message: any): string {
  const contextInfo =
    message?.extendedTextMessage?.contextInfo ??
    message?.imageMessage?.contextInfo ??
    message?.videoMessage?.contextInfo ??
    message?.documentMessage?.contextInfo ??
    message?.buttonsResponseMessage?.contextInfo ??
    message?.listResponseMessage?.contextInfo ??
    null;

  return messageText(contextInfo?.quotedMessage ?? {});
}

export interface NormalizedEvolutionPresence {
  instanceName: string;
  phone: string;
  presence: string;
}

export function normalizeEvolutionPresence(payload: any): NormalizedEvolutionPresence | null {
  const body = payload?.body ?? payload ?? {};
  if (normalizedEvent(body?.event) !== 'PRESENCE_UPDATE') return null;

  const data = body?.data ?? {};
  const instanceName = String(
    body?.instance_name ??
    body?.instance ??
    data?.instance ??
    ''
  ).trim();

  const presences = data?.presences && typeof data.presences === 'object'
    ? data.presences
    : {};
  const entries = Object.entries(presences) as Array<[string, any]>;
  const presenceEntry = entries.find(([, value]) => value?.lastKnownPresence || value?.presence) ?? entries[0];

  // Quando a Evolution fornece o JID dentro de `presences`, ele é preferível ao
  // `id` externo, que em algumas versões pode ser um LID em vez do número real.
  const candidateJid = String(
    presenceEntry?.[0] ??
    data?.id ??
    data?.remoteJid ??
    data?.sender ??
    body?.sender ??
    ''
  ).trim();
  const phone = digits(candidateJid);
  const presence = String(
    presenceEntry?.[1]?.lastKnownPresence ??
    presenceEntry?.[1]?.presence ??
    data?.lastKnownPresence ??
    data?.presence ??
    ''
  ).trim().toLowerCase();

  if (!instanceName || !phone || !presence) return null;
  return { instanceName, phone, presence };
}

export function normalizeEvolutionMessage(payload: any): NormalizedMessage {
  const body = payload?.body ?? payload ?? {};
  const data = body?.data ?? {};
  const key = data?.key ?? body?.key ?? {};
  const message = data?.message ?? body?.message ?? {};

  const event = normalizedEvent(body?.event);

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
      : messageText(message)
  ).trim();

  const quotedText = quotedTextFrom(message);

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
    quotedText: quotedText || undefined,
    raw: payload
  };
}

export function isMessageUpsert(event: string): boolean {
  return event === 'MESSAGES_UPSERT' || event === 'MESSAGE_UPSERT';
}
