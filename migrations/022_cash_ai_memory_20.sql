-- Arles Cash 2.8.0
-- Mantém somente as 15 mensagens frias mais recentes por conversa no Postgres.
-- As 5 mensagens mais recentes passam a viver na camada quente do Redis.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, phone
      ORDER BY id DESC
    ) AS position
  FROM cash_conversation_messages
)
DELETE FROM cash_conversation_messages messages
USING ranked
WHERE messages.id = ranked.id
  AND ranked.position > 15;

UPDATE vertical_definitions
SET version = '2.8.0', updated_at = now()
WHERE id = 'cash';
