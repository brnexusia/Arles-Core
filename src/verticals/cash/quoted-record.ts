import { db } from '../../infrastructure/db.js';

function cleanPhone(value: string): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 20);
}

export interface CashQuotedRecord {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  category: string;
  merchant: string | null;
  description: string | null;
  transaction_date: string;
  created_at: Date | string;
  source_message_id: string | null;
}

export async function findCashRecordsByQuotedMessage(input: {
  companyId: string;
  phone: string;
  quotedMessageId?: string;
  quotedText?: string;
}): Promise<CashQuotedRecord[]> {
  const messageId = String(input.quotedMessageId ?? '').trim();
  const quotedText = String(input.quotedText ?? '').trim().slice(0, 1000);
  if (!messageId && !quotedText) return [];

  const result = await db.query(
    `select id::text,type,amount::float8,category,merchant,description,
            transaction_date,created_at,source_message_id
     from cash_transactions
     where company_id=$1
       and ($2::text='' or user_phone=$2)
       and (
         ($3::text<>'' and (
           source_message_id=$3
           or source_message_id like ($3 || ':item:%')
         ))
         or
         ($4::text<>'' and source_message is not null and position(lower($4) in lower(source_message)) > 0)
       )
     order by created_at asc,id asc
     limit 12`,
    [input.companyId, cleanPhone(input.phone), messageId, quotedText]
  );

  return result.rows as CashQuotedRecord[];
}
