import type { VerticalContext, VerticalResult } from '../vertical.js';
import { redis } from '../../infrastructure/redis.js';

const MAX_MESSAGES = 30;
const MESSAGE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_MESSAGE_CHARS = 1800;

export type CashConversationMemoryEntry = {
  role: 'user' | 'assistant';
  text: string;
  messageId: string | null;
  at: string;
};

function phoneDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

function memoryKey(companyId: string, phone: string): string {
  return `arles:cash:conversation-memory:${companyId}:${phoneDigits(phone)}`;
}

function seenKey(companyId: string, phone: string, messageId: string, role: 'user' | 'assistant'): string {
  return `arles:cash:conversation-memory-seen:${companyId}:${phoneDigits(phone)}:${messageId}:${role}`;
}

function cleanText(value: string): string {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, MAX_MESSAGE_CHARS);
}

async function append(
  companyId: string,
  phone: string,
  role: 'user' | 'assistant',
  text: string,
  messageId: string | null
): Promise<void> {
  const clean = cleanText(text);
  if (!clean) return;

  if (messageId) {
    const accepted = await redis.set(
      seenKey(companyId, phone, messageId, role),
      '1',
      'EX',
      MESSAGE_TTL_SECONDS,
      'NX'
    );
    if (accepted !== 'OK') return;
  }

  const entry: CashConversationMemoryEntry = {
    role,
    text: clean,
    messageId,
    at: new Date().toISOString()
  };
  const key = memoryKey(companyId, phone);
  await redis.rpush(key, JSON.stringify(entry));
  await redis.ltrim(key, -MAX_MESSAGES, -1);
  await redis.expire(key, MESSAGE_TTL_SECONDS);
}

export async function rememberCashUserMessage(context: VerticalContext): Promise<void> {
  await append(
    context.company.id,
    context.message.phone,
    'user',
    context.combinedText,
    context.message.messageId || null
  );
}

export async function rememberCashAssistantResult(
  context: VerticalContext,
  result: VerticalResult | null | undefined
): Promise<void> {
  if (!result) return;
  const text = result.actions
    .filter(action => action.type === 'text')
    .map(action => action.type === 'text' ? action.text : '')
    .filter(Boolean)
    .join('\n\n');
  if (!text) return;

  await append(
    context.company.id,
    context.message.phone,
    'assistant',
    text,
    context.message.messageId || null
  );
}

export async function loadCashConversationMemory(
  companyId: string,
  phone: string,
  limit = MAX_MESSAGES
): Promise<CashConversationMemoryEntry[]> {
  const bounded = Math.max(1, Math.min(MAX_MESSAGES, Math.floor(limit)));
  const raw = await redis.lrange(memoryKey(companyId, phone), -bounded, -1);
  const entries: CashConversationMemoryEntry[] = [];

  for (const item of raw) {
    try {
      const parsed = JSON.parse(item) as CashConversationMemoryEntry;
      if ((parsed.role !== 'user' && parsed.role !== 'assistant') || !parsed.text) continue;
      entries.push({
        role: parsed.role,
        text: cleanText(parsed.text),
        messageId: parsed.messageId ? String(parsed.messageId) : null,
        at: parsed.at ? String(parsed.at) : ''
      });
    } catch {
      // Memória inválida não deve quebrar a conversa.
    }
  }
  return entries;
}

export async function clearCashConversationMemory(companyId: string, phone: string): Promise<void> {
  await redis.del(memoryKey(companyId, phone));
}

export const cashConversationMemorySize = MAX_MESSAGES;
