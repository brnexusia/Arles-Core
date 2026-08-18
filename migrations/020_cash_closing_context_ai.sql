UPDATE vertical_definitions
SET version = '2.5.1',
    updated_at = now()
WHERE id = 'cash';
