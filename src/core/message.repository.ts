import { db } from '../infrastructure/db.js';

export async function logIncoming(input: {
  companyId: string;
  phone: string;
  messageId: string;
  messageType: string;
  body: string;
  rawPayload: unknown;
}): Promise<void> {
  await db.query(
    `
    insert into messages (
      company_id,
      phone_number,
      message_id,
      direction,
      message_type,
      body,
      raw_payload
    )
    values ($1, $2, $3, 'in', $4, $5, $6::jsonb)
    on conflict do nothing
    `,
    [
      input.companyId,
      input.phone,
      input.messageId || null,
      input.messageType,
      input.body,
      JSON.stringify(input.rawPayload ?? {})
    ]
  );
}

export async function logOutgoing(input: {
  companyId: string;
  phone: string;
  body: string;
}): Promise<void> {
  await db.query(
    `
    insert into messages (
      company_id,
      phone_number,
      direction,
      message_type,
      body
    )
    values ($1, $2, 'out', 'text', $3)
    `,
    [input.companyId, input.phone, input.body]
  );
}
