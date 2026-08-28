import { db } from '../../infrastructure/db.js';
import { redis } from '../../infrastructure/redis.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';

const TOTAL_MESSAGES = 20;
const POSTGRES_MESSAGES = 15;
const REDIS_MESSAGES = 5;
const MAX_MESSAGE_CHARS = 1800;

export type CashConversationMemoryEntry = {
  role: 'user' | 'assistant';
  text: string;
  messageId: string | null;
  at: string;
};

type MemoryRow = {
  role: 'user' | 'assistant';
  body: string;
  message_id: string | null;
  created_at: string;
};

function phoneDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

function cleanText(value: string): string {
  return String(value ?? '').split('\u0000').join('').trim().slice(0, MAX_MESSAGE_CHARS);
}

function redisMemoryKey(companyId: string, phone: string): string {
  return `arles:cash:conversation-memory:${companyId}:${phoneDigits(phone)}`;
}

function entryKey(entry: CashConversationMemoryEntry): string {
  return entry.messageId
    ? `${entry.role}:id:${entry.messageId}`
    : `${entry.role}:at:${entry.at}:text:${entry.text}`;
}

function parseRedisEntry(raw: unknown): CashConversationMemoryEntry | null {
  try {
    const parsed = JSON.parse(String(raw ?? '')) as Partial<CashConversationMemoryEntry>;
    if (parsed.role !== 'user' && parsed.role !== 'assistant') return null;
    const text = cleanText(parsed.text ?? '');
    if (!text) return null;
    return {
      role: parsed.role,
      text,
      messageId: parsed.messageId ? String(parsed.messageId) : null,
      at: String(parsed.at || new Date(0).toISOString())
    };
  } catch {
    return null;
  }
}

async function persistPostgresEntry(
  companyId: string,
  phone: string,
  entry: CashConversationMemoryEntry
): Promise<void> {
  await db.query(
    `insert into cash_conversation_messages(company_id,phone,role,message_id,body,created_at)
     values($1,$2,$3,$4,$5,$6::timestamptz)
     on conflict (company_id,phone,role,message_id) do nothing`,
    [companyId, phone, entry.role, entry.messageId, entry.text, entry.at]
  );
}

async function prunePostgres(companyId: string, phone: string): Promise<void> {
  await db.query(
    `delete from cash_conversation_messages
     where id in (
       select id
       from cash_conversation_messages
       where company_id=$1 and phone=$2
       order by id desc
       offset $3
     )`,
    [companyId, phone, POSTGRES_MESSAGES]
  );
}

async function append(
  companyId: string,
  phone: string,
  role: 'user' | 'assistant',
  text: string,
  messageId: string | null
): Promise<void> {
  const clean = cleanText(text);
  const normalizedPhone = phoneDigits(phone);
  if (!clean || !normalizedPhone) return;

  const entry: CashConversationMemoryEntry = {
    role,
    text: clean,
    messageId,
    at: new Date().toISOString()
  };
  const redisKey = redisMemoryKey(companyId, normalizedPhone);

  try {
    const current = (await redis.lrange(redisKey, 0, -1))
      .map(parseRedisEntry)
      .filter((item): item is CashConversationMemoryEntry => Boolean(item));
    const duplicate = current.some(item =>
      item.role === entry.role && (
        (entry.messageId && item.messageId === entry.messageId)
        || (!entry.messageId && item.text === entry.text)
      )
    );

    if (!duplicate) {
      const overflow = await redis.eval(
        `
          redis.call('RPUSH', KEYS[1], ARGV[1])
          local popped = {}
          while redis.call('LLEN', KEYS[1]) > tonumber(ARGV[2]) do
            local item = redis.call('LPOP', KEYS[1])
            if item then table.insert(popped, item) end
          end
          return popped
        `,
        1,
        redisKey,
        JSON.stringify(entry),
        String(REDIS_MESSAGES)
      );

      if (Array.isArray(overflow)) {
        for (const raw of overflow) {
          const cold = parseRedisEntry(raw);
          if (cold) await persistPostgresEntry(companyId, normalizedPhone, cold);
        }
      }
    }

    // Durante a migração podem existir até 30 mensagens antigas no banco. O corte
    // acontece em toda escrita, deixando somente as 15 mensagens frias mais recentes.
    await prunePostgres(companyId, normalizedPhone);
  } catch (error) {
    // Redis é a camada quente, não um ponto único de falha. Em indisponibilidade,
    // preservamos a mensagem no Postgres e seguimos com até 15 mensagens de contexto.
    try {
      await persistPostgresEntry(companyId, normalizedPhone, entry);
      await prunePostgres(companyId, normalizedPhone);
    } catch (postgresError) {
      console.warn('[CashMemory] falha ao persistir contexto em Redis e Postgres:', postgresError);
    }
    console.warn('[CashMemory] Redis indisponível; usando somente memória fria temporariamente:', error);
  }
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
  const resultText = result.actions
    .filter(action => action.type === 'text')
    .map(action => action.type === 'text' ? action.text : '')
    .filter(Boolean)
    .join('\n\n');
  if (!resultText) return;

  await append(
    context.company.id,
    context.message.phone,
    'assistant',
    resultText,
    context.message.messageId || null
  );
}

export async function loadCashConversationMemory(
  companyId: string,
  phone: string,
  limit = TOTAL_MESSAGES
): Promise<CashConversationMemoryEntry[]> {
  const bounded = Math.max(1, Math.min(TOTAL_MESSAGES, Math.floor(limit)));
  const normalizedPhone = phoneDigits(phone);
  if (!normalizedPhone) return [];

  let cold: CashConversationMemoryEntry[] = [];
  let hot: CashConversationMemoryEntry[] = [];

  try {
    const result = await db.query<MemoryRow>(
      `select role,body,message_id,created_at::text
       from (
         select id,role,body,message_id,created_at
         from cash_conversation_messages
         where company_id=$1 and phone=$2
         order by id desc
         limit $3
       ) recent
       order by id asc`,
      [companyId, normalizedPhone, POSTGRES_MESSAGES]
    );

    cold = result.rows.map(row => ({
      role: row.role,
      text: cleanText(row.body),
      messageId: row.message_id ? String(row.message_id) : null,
      at: String(row.created_at)
    }));
  } catch (error) {
    console.warn('[CashMemory] falha ao carregar memória fria do Postgres:', error);
  }

  try {
    hot = (await redis.lrange(redisMemoryKey(companyId, normalizedPhone), 0, REDIS_MESSAGES - 1))
      .map(parseRedisEntry)
      .filter((item): item is CashConversationMemoryEntry => Boolean(item));
  } catch (error) {
    console.warn('[CashMemory] falha ao carregar memória quente do Redis:', error);
  }

  const seen = new Set<string>();
  const merged: CashConversationMemoryEntry[] = [];
  for (const entry of [...cold, ...hot]) {
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }

  return merged.slice(-bounded);
}

export async function clearCashConversationMemory(companyId: string, phone: string): Promise<void> {
  const normalizedPhone = phoneDigits(phone);
  if (!normalizedPhone) return;

  await Promise.allSettled([
    db.query('delete from cash_conversation_messages where company_id=$1 and phone=$2', [companyId, normalizedPhone]),
    redis.del(redisMemoryKey(companyId, normalizedPhone))
  ]);
}

export const cashConversationMemorySize = TOTAL_MESSAGES;
export const cashConversationPostgresMemorySize = POSTGRES_MESSAGES;
export const cashConversationRedisMemorySize = REDIS_MESSAGES;
