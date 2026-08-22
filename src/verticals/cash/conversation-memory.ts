import { db } from '../../infrastructure/db.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';

const MAX_MESSAGES = 30;
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

  await db.query(
    `insert into cash_conversation_messages(company_id,phone,role,message_id,body)
     values($1,$2,$3,$4,$5)
     on conflict (company_id,phone,role,message_id) do nothing`,
    [companyId, normalizedPhone, role, messageId, clean]
  );

  // A memória operacional é deliberadamente curta: apenas as 30 mensagens mais
  // recentes daquele usuário naquela empresa. O restante não entra no prompt.
  await db.query(
    `delete from cash_conversation_messages
     where id in (
       select id
       from cash_conversation_messages
       where company_id=$1 and phone=$2
       order by id desc
       offset $3
     )`,
    [companyId, normalizedPhone, MAX_MESSAGES]
  );
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
  limit = MAX_MESSAGES
): Promise<CashConversationMemoryEntry[]> {
  const bounded = Math.max(1, Math.min(MAX_MESSAGES, Math.floor(limit)));
  const normalizedPhone = phoneDigits(phone);
  if (!normalizedPhone) return [];

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
    [companyId, normalizedPhone, bounded]
  );

  return result.rows.map(row => ({
    role: row.role,
    text: cleanText(row.body),
    messageId: row.message_id ? String(row.message_id) : null,
    at: String(row.created_at)
  }));
}

export async function clearCashConversationMemory(companyId: string, phone: string): Promise<void> {
  const normalizedPhone = phoneDigits(phone);
  if (!normalizedPhone) return;
  await db.query(
    'delete from cash_conversation_messages where company_id=$1 and phone=$2',
    [companyId, normalizedPhone]
  );
}

export const cashConversationMemorySize = MAX_MESSAGES;
