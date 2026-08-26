create extension if not exists pgcrypto;

create table if not exists assist_settings (
  company_id uuid primary key references companies(id) on delete cascade,
  business_name text,
  address text,
  instagram text,
  opening_hours text,
  diagnosis_fee numeric(12,2) not null default 0,
  diagnosis_waived_if_approved boolean not null default true,
  pickup_enabled boolean not null default false,
  default_warranty_days integer not null default 90,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists assist_services (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  category text not null,
  equipment_type text not null,
  brand text,
  model_pattern text,
  name text not null,
  description text,
  pricing_mode text not null default 'diagnosis' check (pricing_mode in ('exact','range','diagnosis')),
  price_min numeric(12,2),
  price_max numeric(12,2),
  labor_price numeric(12,2),
  parts_price numeric(12,2),
  requires_diagnosis boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_assist_services_company on assist_services(company_id,active,equipment_type);

create table if not exists assist_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  probable_service_id uuid references assist_services(id) on delete set null,
  customer_name text not null default 'Cliente',
  customer_phone text not null,
  channel text not null default 'whatsapp' check (channel in ('whatsapp','instagram','panel','other')),
  equipment_type text,
  brand text,
  model text,
  serial_number text,
  reported_issue text,
  quoted_min numeric(12,2),
  quoted_max numeric(12,2),
  approved_price numeric(12,2),
  status text not null default 'triage' check (status in ('triage','quoted','awaiting_approval','confirmed','received','diagnosis','approved','repairing','ready','delivered','cancelled')),
  diagnosis_notes text,
  internal_notes text,
  promised_at timestamptz,
  source_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_assist_orders_company_status on assist_orders(company_id,status,updated_at desc);
create index if not exists idx_assist_orders_phone on assist_orders(company_id,customer_phone,updated_at desc);

create table if not exists assist_order_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  order_id uuid not null references assist_orders(id) on delete cascade,
  event_type text not null,
  from_status text,
  to_status text,
  note text,
  actor text not null default 'system',
  created_at timestamptz not null default now()
);
create index if not exists idx_assist_order_events_order on assist_order_events(order_id,created_at desc);
