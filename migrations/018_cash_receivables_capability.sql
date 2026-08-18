UPDATE vertical_definitions
SET capabilities = CASE
      WHEN NOT ('cash.receivables' = ANY(capabilities)) THEN array_append(capabilities, 'cash.receivables')
      ELSE capabilities
    END,
    version = '2.4.0',
    updated_at = now()
WHERE id = 'cash';
