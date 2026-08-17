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

function contextInfoFrom(message: any): any {
  return (
    message?.extendedTextMessage?.contextInfo ??
    message?.imageMessage?.contextInfo ??
    message?.videoMessage?.contextInfo ??
    message?.documentMessage?.contextInfo ??
    message?.buttonsResponseMessage?.contextInfo ??
    message?.listResponseMessage?.contextInfo ??
    null
  );
}

function quotedTextFrom(message: any): string {
  return messageText(contextInfoFrom(message)?.quotedMessage ?? {});
}

function quotedMessageIdFrom(message: any): string {
  const contextInfo = contextInfoFrom(message);
  return String(
    contextInfo?.stanzaId ??
    contextInfo?.quotedMessage?.key?.id ??
    ''
  ).trim();
}

function firstData(body: any): any {
  const raw = body?.data ?? {};
  return Array.isArray(raw) ? (raw[0] ?? {}) : raw;
}

function resolveAddress(body: any, data: any) {
  const key = data?.key ?? data?.update?.key ?? body?.key ?? {};
  const rawJid = String(
    body?.phone ??
    key?.remoteJid ??
    data?.remoteJid ??
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
  if (rawJid.includes('@lid') && altJid) replyJid = altJid;
  if (replyJid && !replyJid.includes('@') && /^\+?\d+$/.test(replyJid)) {
    replyJid = `${digits(replyJid)}@s.whatsapp.net`;
  }

  return { key, rawJid, replyJid, phone: digits(replyJid || rawJid) };
}

function editedPayload(data: any): any {
  return (
    data?.update?.message?.editedMessage?.message ??
    data?.message?.editedMessage?.message ??
    data?.editedMessage?.message ??
    data?.update?.message?.protocolMessage?.editedMessage ??
    data?.message?.protocolMessage?.editedMessage ??
    data?.protocolMessage?.editedMessage ??
    null
  );
}

function editedTargetId(data: any): string {
  return String(
    data?.update?.message?.protocolMessage?.key?.id ??
    data?.message?.protocolMessage?.key?.id ??
    data?.protocolMessage?.key?.id ??
    data?.key?.id ??
    data?.update?.key?.id ??
    data?.keyId ??
    data?.messageId ??
    ''
  ).trim();
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

/**
 * Evolution já expôs edições como MESSAGES_EDITED e, em algumas versões, dentro
 * de MESSAGES_UPDATE/protocolMessage. Esta normalização aceita os formatos sem
 * transformar updates de status/ACK em uma mensagem financeira.
 */
export function normalizeEvolutionEditedMessage(payload: any): NormalizedMessage | null {
  const body = payload?.body ?? payload ?? {};
  const event = normalizedEvent(body?.event);
  const data = firstData(body);
  const edited = editedPayload(data);
  const editedText = messageText(edited ?? {});
  const targetId = editedTargetId(data);

  const eventAllowsEdit = event === 'MESSAGES_EDITED' || event === 'MESSAGE_EDITED' || event === 'MESSAGES_UPDATE' || event === 'MESSAGE_UPDATE' || Boolean(edited);
  if (!eventAllowsEdit || !edited || !editedText || !targetId) return null;

  const instanceName = String(
    body?.instance_name ??
    body?.instance ??
    data?.instance ??
    ''
  ).trim();
  const { key, rawJid, replyJid, phone } = resolveAddress(body, data);
  if (!instanceName || !phone) return null;

  return {
    messageId: String(data?.id ?? data?.messageId ?? body?.message_id ?? targetId),
    instanceName,
    remoteJid: rawJid,
    replyJid,
    phone,
    pushName: String(data?.pushName ?? body?.pushName ?? ''),
    fromMe: body?.from_me === true || key?.fromMe === true,
    isGroup: rawJid.endsWith('@g.us'),
    isBroadcast: rawJid.includes('@broadcast') || rawJid.includes('status@broadcast'),
    event,
    type: 'text',
    text: editedText,
    isEdit: true,
    editedMessageId: targetId,
    raw: payload
  };
}

export function normalizeEvolutionMessage(payload: any): NormalizedMessage {
  const body = payload?.body ?? payload ?? {};
  const data = firstData(body);
  const { key, rawJid, replyJid, phone } = resolveAddress(body, data);
  const message = data?.message ?? body?.message ?? {};
  const event = normalizedEvent(body?.event);

  const instanceName = String(
    body?.instance_name ??
    body?.instance ??
    data?.instance ??
    ''
  ).trim();

  const text = String(
    typeof body?.message === 'string'
      ? body.message
      : messageText(message)
  ).trim();

  const quotedText = quotedTextFrom(message);
  const quotedMessageId = quotedMessageIdFrom(message);

  let type: NormalizedMessage['type'] = 'unsupported';
  if (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    (text && !message?.imageMessage && !message?.audioMessage)
  ) type = 'text';
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
    isBroadcast: rawJid.includes('@broadcast') || rawJid.includes('status@broadcast'),
    event,
    type,
    text,
    quotedText: quotedText || undefined,
    quotedMessageId: quotedMessageId || undefined,
    raw: payload
  };
}

export function isMessageUpsert(event: string): boolean {
  return event === 'MESSAGES_UPSERT' || event === 'MESSAGE_UPSERT';
}

export function isMessageEditEvent(event: string): boolean {
  return event === 'MESSAGES_EDITED' || event === 'MESSAGE_EDITED' || event === 'MESSAGES_UPDATE' || event === 'MESSAGE_UPDATE';
}
