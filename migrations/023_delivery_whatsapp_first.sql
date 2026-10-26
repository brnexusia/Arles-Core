-- Delivery-only WhatsApp First. Non-Delivery tenant data remains untouched.
alter table whatsapp_connections
  add column if not exists evolution_token text;

create table if not exists delivery_operations (
  company_id uuid primary key references companies(id) on delete cascade,
  group_jid text unique,
  pairing_hash text,
  pairing_expires_at timestamptz,
  manually_closed boolean not null default false,
  menu_dirty boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint delivery_group_jid_format check (
    group_jid is null or group_jid ~ '^[0-9]+@g[.]us$'
  )
);
create index if not exists idx_delivery_ops_pairing on delivery_operations(pairing_hash)
where pairing_hash is not null;
