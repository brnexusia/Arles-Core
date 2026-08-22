CREATE TABLE IF NOT EXISTS cash_conversation_messages (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  phone text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  message_id text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, phone, role, message_id)
);

CREATE INDEX IF NOT EXISTS idx_cash_conversation_messages_recent
  ON cash_conversation_messages(company_id, phone, id DESC);

UPDATE vertical_definitions
SET
  version = '2.7.0',
  capabilities = CASE
    WHEN 'cash.conversation_memory' = ANY(capabilities) THEN capabilities
    ELSE array_append(capabilities, 'cash.conversation_memory')
  END,
  updated_at = now()
WHERE id = 'cash';
