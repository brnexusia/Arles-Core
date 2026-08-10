import { db } from '../../infrastructure/db.js';
import type {
  DeliveryCustomer,
  DeliveryDraft,
  DeliveryProduct,
  DeliveryState,
  DeliveryStore
} from './types.js';

export async function getDeliveryStore(
  companyId: string
): Promise<DeliveryStore | null> {
  const result = await db.query<DeliveryStore>(
    'select * from delivery_store_info where company_id = $1 limit 1',
    [companyId]
  );

  return result.rows[0] ?? null;
}

export async function getActiveProducts(
  companyId: string
): Promise<DeliveryProduct[]> {
  const result = await db.query(
    `
    select
      id::text,
      name,
      coalesce(category, '') as category,
      coalesce(description, '') as description,
      price::float8 as price
    from delivery_products
    where company_id = $1
      and is_active = true
    order by category nulls last, name
    `,
    [companyId]
  );

  return result.rows as DeliveryProduct[];
}

export async function getCustomer(
  companyId: string,
  phone: string
): Promise<DeliveryCustomer | null> {
  const result = await db.query<DeliveryCustomer>(
    `
    select
      id::text,
      name,
      phone_number,
      default_address,
      favorite_payment
    from customers
    where company_id = $1
      and phone_number = $2
    limit 1
    `,
    [companyId, phone]
  );

  return result.rows[0] ?? null;
}

export async function getSession(
  companyId: string,
  phone: string
): Promise<{ state: DeliveryState; draft: DeliveryDraft | null }> {
  const result = await db.query(
    `
    select state, draft
    from conversation_sessions
    where company_id = $1
      and phone_number = $2
    limit 1
    `,
    [companyId, phone]
  );

  const row = result.rows[0];

  if (!row) {
    return { state: 'idle', draft: null };
  }

  return {
    state: row.state as DeliveryState,
    draft: row.draft as DeliveryDraft | null
  };
}

export async function saveSession(input: {
  companyId: string;
  phone: string;
  state: DeliveryState;
  draft: DeliveryDraft | null;
}): Promise<void> {
  await db.query(
    `
    insert into conversation_sessions (
      company_id,
      phone_number,
      vertical,
      state,
      draft,
      updated_at
    )
    values ($1, $2, 'delivery', $3, $4::jsonb, now())
    on conflict (company_id, phone_number)
    do update set
      vertical = excluded.vertical,
      state = excluded.state,
      draft = excluded.draft,
      updated_at = now()
    `,
    [
      input.companyId,
      input.phone,
      input.state,
      input.draft ? JSON.stringify(input.draft) : null
    ]
  );
}

export async function createDeliveryOrder(input: {
  companyId: string;
  phone: string;
  pushName: string;
  draft: DeliveryDraft;
}): Promise<{ id: string; clientName: string; total: number }> {
  const client = await db.connect();

  try {
    await client.query('begin');

    const draftName = input.draft.client_name.trim();
    const clientName =
      draftName ||
      input.pushName.trim() ||
      'Cliente';

    const customer = await client.query(
      `
      insert into customers (
        company_id,
        name,
        phone_number,
        default_address,
        favorite_payment,
        last_seen_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, now(), now())
      on conflict (company_id, phone_number)
      do update set
        name = case
          when excluded.name <> 'Cliente' then excluded.name
          else customers.name
        end,
        default_address = case
          when excluded.default_address is not null
               and excluded.default_address <> ''
            then excluded.default_address
          else customers.default_address
        end,
        favorite_payment = coalesce(
          nullif(excluded.favorite_payment, ''),
          customers.favorite_payment
        ),
        last_seen_at = now(),
        updated_at = now()
      returning id
      `,
      [
        input.companyId,
        clientName,
        input.phone,
        input.draft.delivery_type === 'delivery'
          ? input.draft.delivery_address
          : null,
        input.draft.payment_method || null
      ]
    );

    const subtotal = input.draft.items.reduce(
      (sum, item) => sum + item.unit_price * item.quantity,
      0
    );

    const fee =
      input.draft.delivery_type === 'delivery'
        ? Number(input.draft.delivery_fee || 0)
        : 0;

    const total = Math.round((subtotal + fee) * 100) / 100;

    const order = await client.query(
      `
      insert into delivery_orders (
        company_id,
        customer_id,
        client_name,
        client_phone,
        items,
        observations,
        delivery_type,
        delivery_address,
        total_value,
        status,
        payment_method,
        payment_status,
        change_for
      )
      values (
        $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9,
        'Novos', $10, $11, $12
      )
      returning id::text
      `,
      [
        input.companyId,
        customer.rows[0].id,
        clientName,
        input.phone,
        JSON.stringify(input.draft.items),
        input.draft.observations,
        input.draft.delivery_type,
        input.draft.delivery_type === 'delivery'
          ? input.draft.delivery_address
          : '',
        total,
        input.draft.payment_method,
        input.draft.payment_method === 'pix'
          ? 'pending'
          : 'pay_on_delivery',
        input.draft.payment_method === 'cash'
          ? input.draft.change_for
          : null
      ]
    );

    await client.query(
      `
      update customers
      set
        total_orders = total_orders + 1,
        total_spent = total_spent + $3,
        updated_at = now()
      where company_id = $1
        and phone_number = $2
      `,
      [input.companyId, input.phone, total]
    );

    await client.query('commit');

    return {
      id: order.rows[0].id,
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
