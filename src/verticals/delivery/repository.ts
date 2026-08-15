import { db } from '../../infrastructure/db.js';
import { env } from '../../config/env.js';
import { deliveryConfig } from './config.js';
import type {
  DeliveryCustomer,
  DeliveryDraft,
  DeliveryProduct,
  DeliveryState,
  DeliveryStore,
  MenuAsset,
  PendingPixOrder,
  ProductVariation
} from './types.js';


export async function getCompanySettings(
  companyId: string
): Promise<Record<string, unknown>> {
  const result = await db.query<{ config: Record<string, unknown> }>(
    `select config
     from company_settings
     where company_id = $1
     limit 1`,
    [companyId]
  );

  return result.rows[0]?.config ?? {};
}

export async function getDeliveryStore(companyId: string): Promise<DeliveryStore | null> {
  const result = await db.query<DeliveryStore>(
    'select * from delivery_store_info where company_id = $1 limit 1',
    [companyId]
  );
  return result.rows[0] ?? null;
}

export async function getActiveProducts(companyId: string): Promise<DeliveryProduct[]> {
  const products = await db.query<DeliveryProduct>(
    `select id::text, name, coalesce(category, '') as category,
            coalesce(description, '') as description, price::float8 as price
     from delivery_products
     where company_id = $1 and is_active = true
     order by category nulls last, name`,
    [companyId]
  );

  if (!products.rows.length) return [];

  const ids = products.rows.map(p => p.id);
  const variations = await db.query<ProductVariation & { product_id: string }>(
    `select id::text, product_id::text, name, price_delta::float8 as price_delta
     from delivery_product_variations
     where product_id = any($1::uuid[]) and is_active = true
     order by name`,
    [ids]
  );

  const byProduct = new Map<string, ProductVariation[]>();
  for (const variation of variations.rows) {
    const list = byProduct.get(variation.product_id) ?? [];
    list.push({ id: variation.id, name: variation.name, price_delta: Number(variation.price_delta) });
    byProduct.set(variation.product_id, list);
  }

  return products.rows.map(product => ({
    ...product,
    price: Number(product.price),
    variations: byProduct.get(product.id) ?? []
  }));
}

export async function getMenuAssets(companyId: string): Promise<MenuAsset[]> {
  const result = await db.query<MenuAsset>(
    `select id::text, page_number, asset_url
     from delivery_menu_assets
     where company_id = $1 and is_active = true
     order by page_number asc, created_at asc`,
    [companyId]
  );
  return result.rows;
}

export async function getCustomer(companyId: string, phone: string): Promise<DeliveryCustomer | null> {
  const result = await db.query<DeliveryCustomer>(
    `select id::text, name, phone_number, default_address, favorite_payment
     from customers where company_id = $1 and phone_number = $2 limit 1`,
    [companyId, phone]
  );
  return result.rows[0] ?? null;
}

export async function getSession(companyId: string, phone: string): Promise<{ state: DeliveryState; draft: DeliveryDraft | null }> {
  const result = await db.query<{ state: DeliveryState; draft: DeliveryDraft | null; updated_at: Date }>(
    `select state, draft, updated_at from conversation_sessions
     where company_id = $1 and phone_number = $2 and vertical = 'delivery' limit 1`,
    [companyId, phone]
  );
  const row = result.rows[0];
  if (!row) return { state: 'idle', draft: null };

  const updatedAt = row.updated_at instanceof Date
    ? row.updated_at.getTime()
    : new Date(row.updated_at).getTime();
  const staleDraft = Boolean(
    row.draft?.items?.length &&
    Number.isFinite(updatedAt) &&
    Date.now() - updatedAt > deliveryConfig.draftTtlSeconds * 1000
  );

  if (staleDraft) {
    await db.query(
      `update conversation_sessions
       set state = 'idle', draft = null, updated_at = now()
       where company_id = $1 and phone_number = $2 and vertical = 'delivery'`,
      [companyId, phone]
    );
    return { state: 'idle', draft: null };
  }

  return { state: row.state as DeliveryState, draft: row.draft as DeliveryDraft | null };
}

export async function saveSession(input: {
  companyId: string;
  phone: string;
  state: DeliveryState;
  draft: DeliveryDraft | null;
}): Promise<void> {
  await db.query(
    `insert into conversation_sessions (company_id, phone_number, vertical, state, draft, updated_at)
     values ($1, $2, 'delivery', $3, $4::jsonb, now())
     on conflict (company_id, phone_number, vertical)
     do update set state = excluded.state,
                   draft = excluded.draft, updated_at = now()`,
    [input.companyId, input.phone, input.state, input.draft ? JSON.stringify(input.draft) : null]
  );
}

export async function getRecentMessages(companyId: string, phone: string, limit = 12): Promise<Array<{ direction: string; body: string }>> {
  const result = await db.query<{ direction: string; body: string }>(
    `select direction, coalesce(body, '') as body
     from messages
     where company_id = $1 and phone_number = $2
     order by created_at desc limit $3`,
    [companyId, phone, limit]
  );
  return result.rows.reverse();
}

export async function createDeliveryOrder(input: {
  companyId: string;
  phone: string;
  pushName: string;
  draft: DeliveryDraft;
}): Promise<{ id: string; customerId: string; clientName: string; total: number }> {
  const client = await db.connect();

  try {
    await client.query('begin');

    const draftName = input.draft.client_name.trim();
    const clientName = draftName || input.pushName.trim() || 'Cliente';

    const customer = await client.query(
      `insert into customers (
         company_id, name, phone_number, default_address, favorite_payment,
         last_seen_at, updated_at
       ) values ($1, $2, $3, $4, $5, now(), now())
       on conflict (company_id, phone_number)
       do update set
         name = case when excluded.name <> 'Cliente' then excluded.name else customers.name end,
         default_address = case when nullif(excluded.default_address, '') is not null
                           then excluded.default_address else customers.default_address end,
         favorite_payment = coalesce(nullif(excluded.favorite_payment, ''), customers.favorite_payment),
         last_seen_at = now(), updated_at = now()
       returning id::text`,
      [
        input.companyId,
        clientName,
        input.phone,
        input.draft.delivery_type === 'delivery' ? input.draft.delivery_address : null,
        input.draft.payment_method || null
      ]
    );

    const subtotal = input.draft.items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
    const fee = input.draft.delivery_type === 'delivery' ? Number(input.draft.delivery_fee || 0) : 0;
    const total = Math.round((subtotal + fee) * 100) / 100;

    const order = await client.query(
      `insert into delivery_orders (
         company_id, customer_id, client_name, client_phone, items, observations,
         delivery_type, delivery_address, total_value, status, payment_method,
         payment_status, change_for, status_updated_at
       ) values (
         $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9,
         'Novos', $10, $11, $12, now()
       ) returning id::text`,
      [
        input.companyId,
        customer.rows[0].id,
        clientName,
        input.phone,
        JSON.stringify(input.draft.items),
        input.draft.observations,
        input.draft.delivery_type,
        input.draft.delivery_type === 'delivery' ? input.draft.delivery_address : '',
        total,
        input.draft.payment_method,
        input.draft.payment_method === 'pix' ? 'pending' : 'pay_on_delivery',
        input.draft.payment_method === 'cash' ? input.draft.change_for : null
      ]
    );

    await client.query(
      `update customers set total_orders = total_orders + 1,
                            total_spent = total_spent + $3,
                            updated_at = now()
       where company_id = $1 and phone_number = $2`,
      [input.companyId, input.phone, total]
    );

    await client.query('commit');

    return {
      id: order.rows[0].id,
      customerId: customer.rows[0].id,
      clientName,
      total
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function getPendingPixOrder(companyId: string, phone: string): Promise<PendingPixOrder | null> {
  const hours = Math.max(1, deliveryConfig.pixProofMaxAgeHours);
  const result = await db.query<PendingPixOrder>(
    `select id::text, client_name, payment_status, total_value::float8 as total_value,
            status, created_at
     from delivery_orders
     where company_id = $1
       and client_phone = $2
       and payment_method = 'pix'
       and payment_status in ('pending', 'pending_approval')
       and status not in ('Finalizados', 'Cancelados')
       and created_at >= now() - ($3::text || ' hours')::interval
     order by created_at desc
     limit 1`,
    [companyId, phone, String(hours)]
  );
  return result.rows[0] ?? null;
}

export async function savePixProof(input: {
  companyId: string;
  orderId: string;
  expectedPaymentStatus: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<{ token: string; url: string }> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const media = await client.query<{ public_token: string }>(
      `insert into media_files (
         company_id, order_id, owner_vertical, owner_type, owner_id,
         kind, mime_type, data, size_bytes
       ) values ($1, $2, 'delivery', 'order', $2, 'pix_proof', $3, $4, $5)
       returning public_token::text`,
      [input.companyId, input.orderId, input.mimeType || 'image/jpeg', input.bytes, input.bytes.length]
    );

    const token = media.rows[0]!.public_token;
    const url = env.publicBaseUrl ? `${env.publicBaseUrl}/media/${token}` : `/media/${token}`;

    const updated = await client.query(
      `update delivery_orders
       set payment_status = 'pending_approval', payment_proof_url = $4, updated_at = now()
       where id = $1 and company_id = $2 and payment_status = $3
       returning id`,
      [input.orderId, input.companyId, input.expectedPaymentStatus, url]
    );

    if (!updated.rowCount) {
      throw new Error('Pedido PIX mudou de estado antes de salvar o comprovante.');
    }

    await client.query('commit');
    return { token, url };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function registerReview(input: {
  companyId: string;
  orderId: string;
  customerName: string;
  phone: string;
  rating: number;
}): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into delivery_reviews (company_id, order_id, customer_name, phone_number, rating)
       values ($1, $2, $3, $4, $5)
       on conflict do nothing`,
      [input.companyId, input.orderId || null, input.customerName || null, input.phone, input.rating]
    );
    await client.query(
      `update customers
       set last_rating = $3, last_review_at = now(), updated_at = now()
       where company_id = $1 and phone_number = $2`,
      [input.companyId, input.phone, input.rating]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateOrderStatus(input: {
  companyId: string;
  orderId: string;
  status: string;
}): Promise<{
  orderId: string;
  companyId: string;
  companyName: string;
  companyInstagram: string;
  instanceName: string;
  customerId: string;
  clientName: string;
  clientPhone: string;
  previousStatus: string;
  status: string;
} | null> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const current = await client.query(
      `select o.status, o.customer_id::text, o.client_name, o.client_phone,
              c.name as company_name, coalesce(c.instagram, '') as instagram,
              c.evolution_instance
       from delivery_orders o
       join companies c on c.id = o.company_id
       where o.id = $1 and o.company_id = $2
       for update`,
      [input.orderId, input.companyId]
    );
    if (!current.rows[0]) {
      await client.query('rollback');
      return null;
    }

    const row = current.rows[0];
    await client.query(
      `update delivery_orders
       set status = $3,
           status_updated_at = now(),
           updated_at = now(),
           delivered_at = case when $3 = 'Finalizados' then coalesce(delivered_at, now()) else delivered_at end
       where id = $1 and company_id = $2`,
      [input.orderId, input.companyId, input.status]
    );
    await client.query('commit');

    return {
      orderId: input.orderId,
      companyId: input.companyId,
      companyName: String(row.company_name ?? ''),
      companyInstagram: String(row.instagram ?? ''),
      instanceName: String(row.evolution_instance ?? ''),
      customerId: String(row.customer_id ?? ''),
      clientName: String(row.client_name ?? ''),
      clientPhone: String(row.client_phone ?? ''),
      previousStatus: String(row.status ?? ''),
      status: input.status
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}


export async function updatePaymentStatus(input: {
  companyId: string;
  orderId: string;
  paymentStatus: 'pending' | 'pending_approval' | 'approved' | 'rejected';
}): Promise<boolean> {
  const result = await db.query(
    `update delivery_orders
     set payment_status = $3,
         payment_approved_at = case
           when $3 = 'approved' then now()
           when $3 in ('pending', 'pending_approval', 'rejected') then null
           else payment_approved_at
         end,
         updated_at = now()
     where id = $1
       and company_id = $2`,
    [input.orderId, input.companyId, input.paymentStatus]
  );

  return Boolean(result.rowCount);
}
