import { db } from '../infrastructure/db.js';
import { env } from '../config/env.js';
import { evolution } from '../whatsapp/evolution.client.js';
import { deliveryPostSaleService } from '../post-sale/delivery-post-sale.service.js';
import { updatePaymentStatus } from '../verticals/delivery/repository.js';
import { randomUUID } from 'node:crypto';

export type PanelCompanyBootstrap = {
  id: string;
  name: string;
  subscriptionStatus?: string | null;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  instagram?: string | null;
  storeInfoCompleted?: boolean;
  whatsappCompleted?: boolean;
  onboardingCompleted?: boolean;
  logoUrl?: string | null;
};

function deterministicInstance(companyId: string): string {
  return `arles-${companyId.replace(/-/g, '').slice(0, 24)}`;
}

function cleanString(value: unknown): string {
  return String(value ?? '').trim();
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toBase64Payload(value: string): { mimeType: string; bytes: Buffer } {
  const input = value.trim();
  const match = input.match(/^data:([^;]+);base64,(.+)$/s);
  const mimeType = match?.[1] || 'image/png';
  const raw = match?.[2] || input;
  return { mimeType, bytes: Buffer.from(raw, 'base64') };
}

export class PanelService {
  async bootstrapCompany(input: PanelCompanyBootstrap): Promise<{ needsLegacyMigration: boolean }> {
    if (!validUuid(input.id)) throw new Error('company_id inválido');
    const instance = deterministicInstance(input.id);

    await db.query(
      `insert into companies (
         id, name, slug, vertical, evolution_instance,
         subscription_status, access_active, trial_started_at, trial_ends_at,
         instagram, store_info_completed, whatsapp_completed, onboarding_completed, logo_url,
         created_at, updated_at
       ) values (
         $1, $2, $3, 'delivery', $4,
         $5, true, $6::timestamptz, $7::timestamptz,
         $8, $9, $10, $11, $12, now(), now()
       )
       on conflict (id) do update set
         name = excluded.name,
         subscription_status = excluded.subscription_status,
         trial_started_at = coalesce(excluded.trial_started_at, companies.trial_started_at),
         trial_ends_at = coalesce(excluded.trial_ends_at, companies.trial_ends_at),
         instagram = coalesce(nullif(excluded.instagram, ''), companies.instagram),
         logo_url = coalesce(nullif(excluded.logo_url, ''), companies.logo_url),
         updated_at = now()`,
      [
        input.id,
        input.name || 'Delivery',
        `delivery-${input.id.replace(/-/g, '').slice(0, 16)}`,
        instance,
        input.subscriptionStatus || 'trial',
        input.trialStartedAt || null,
        input.trialEndsAt || null,
        input.instagram || null,
        input.storeInfoCompleted === true,
        input.whatsappCompleted === true,
        input.onboardingCompleted === true,
        input.logoUrl || null
      ]
    );

    await db.query(
      `insert into whatsapp_connections (company_id, instance_name, status)
       values ($1, $2, 'disconnected')
       on conflict (company_id) do nothing`,
      [input.id, instance]
    );

    const migration = await db.query<{ legacy_supabase_migrated: boolean }>(
      `select legacy_supabase_migrated from companies where id = $1 limit 1`,
      [input.id]
    );
    return { needsLegacyMigration: migration.rows[0]?.legacy_supabase_migrated !== true };
  }

  async companyProgress(companyId: string) {
    const result = await db.query(
      `select id::text, name, store_info_completed, whatsapp_completed,
              onboarding_completed, subscription_status, trial_started_at,
              trial_ends_at, instagram, logo_url, legacy_supabase_migrated
       from companies where id = $1 limit 1`,
      [companyId]
    );
    return result.rows[0] ?? null;
  }

  async setOnboardingComplete(companyId: string, complete = true): Promise<void> {
    await db.query(
      `update companies
       set onboarding_completed = $2, updated_at = now()
       where id = $1`,
      [companyId, complete]
    );
  }

  async listOrders(companyId: string) {
    const result = await db.query(
      `select id::text, company_id::text, customer_id::text,
              client_name, client_phone, items, observations,
              delivery_type, delivery_address, total_value::float8 as total_value,
              status, payment_method, payment_status, change_for::float8 as change_for,
              payment_proof_url, payment_approved_at, delivered_at,
              created_at, updated_at
       from delivery_orders
       where company_id = $1
       order by created_at desc`,
      [companyId]
    );
    return result.rows;
  }

  async updateOrderStatus(companyId: string, orderId: string, status: string) {
    return deliveryPostSaleService.updateAndNotify({ companyId, orderId, status });
  }

  async updateOrderPayment(companyId: string, orderId: string, status: string) {
    const allowed = new Set(['pending', 'pending_approval', 'approved', 'rejected']);
    if (!allowed.has(status)) throw new Error('payment_status inválido');
    const updated = await updatePaymentStatus({
      companyId,
      orderId,
      paymentStatus: status as 'pending' | 'pending_approval' | 'approved' | 'rejected'
    });
    if (!updated) throw new Error('Pedido não encontrado');
    return { payment_status: status };
  }

  async listCustomers(companyId: string) {
    const result = await db.query(
      `select c.id::text, c.company_id::text, c.name, c.phone_number, c.notes,
              c.default_address, c.favorite_payment, c.last_rating, c.last_review_at,
              c.total_orders as orders_count,
              c.total_spent::float8 as total_spent,
              c.first_seen_at as first_order_at, c.first_seen_at, c.last_seen_at,
              coalesce(max(o.created_at), c.last_seen_at) as last_order_at,
              c.created_at
       from customers c
       left join delivery_orders o on o.customer_id = c.id and o.company_id = c.company_id
       where c.company_id = $1
       group by c.id
       order by c.last_seen_at desc`,
      [companyId]
    );
    return result.rows;
  }

  async customerOrders(companyId: string, customerId: string) {
    const result = await db.query(
      `select id::text, client_name, client_phone, items, observations,
              delivery_type, delivery_address, total_value::float8 as total_value,
              status, payment_method, payment_status, created_at
       from delivery_orders
       where company_id = $1 and customer_id = $2
       order by created_at desc`,
      [companyId, customerId]
    );
    return result.rows;
  }

  async updateCustomerNotes(companyId: string, customerId: string, notes: string) {
    const result = await db.query(
      `update customers
       set notes = $3, updated_at = now()
       where id = $1 and company_id = $2
       returning id::text, notes`,
      [customerId, companyId, notes.trim() || null]
    );
    if (!result.rows[0]) throw new Error('Cliente não encontrado');
    return result.rows[0];
  }

  async migrateLegacyData(companyId: string, payload: Record<string, any>) {
    const check = await db.query<{ legacy_supabase_migrated: boolean }>(
      `select legacy_supabase_migrated from companies where id = $1 limit 1`,
      [companyId]
    );
    if (!check.rows[0]) throw new Error('Empresa não encontrada');
    if (check.rows[0].legacy_supabase_migrated) return { migrated: false, reason: 'already_migrated' };

    const client = await db.connect();
    try {
      await client.query('begin');

      const store = payload.store_info || payload.storeInfo;
      if (store) {
        await client.query(
          `insert into delivery_store_info (
             company_id, store_name, short_description, avg_time, min_order,
             opening_hours, delivery_fee, neighborhoods, payment_methods,
             pix_key, ai_rules, ai_enabled, updated_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
           on conflict (company_id) do update set
             store_name=excluded.store_name, short_description=excluded.short_description,
             avg_time=excluded.avg_time, min_order=excluded.min_order,
             opening_hours=excluded.opening_hours, delivery_fee=excluded.delivery_fee,
             neighborhoods=excluded.neighborhoods, payment_methods=excluded.payment_methods,
             pix_key=excluded.pix_key, ai_rules=excluded.ai_rules,
             ai_enabled=excluded.ai_enabled, updated_at=now()`,
          [companyId, cleanString(store.store_name) || payload.company_name || 'Delivery',
           cleanString(store.short_description), cleanString(store.avg_time), Number(store.min_order)||0,
           cleanString(store.opening_hours), cleanString(store.delivery_fee), cleanString(store.neighborhoods),
           cleanString(store.payment_methods), cleanString(store.pix_key), cleanString(store.ai_rules), store.ai_enabled !== false]
        );
      }

      const settings = payload.settings;
      if (settings) {
        const config = {
          display_name: cleanString(settings.display_name),
          phone: cleanString(settings.phone),
          email: cleanString(settings.email),
          notifications_sound: settings.notifications_sound !== false
        };
        await client.query(
          `insert into company_settings(company_id, config, updated_at)
           values($1,$2::jsonb,now())
           on conflict(company_id) do update set config=excluded.config,updated_at=now()`,
          [companyId, JSON.stringify(config)]
        );
        const instagram = cleanString(settings.instagram);
        if (instagram) await client.query(`update companies set instagram=$2 where id=$1`, [companyId, instagram]);
      }

      const productIdMap = new Map<string,string>();
      for (const product of Array.isArray(payload.products) ? payload.products : []) {
        const oldId = cleanString(product.id);
        const id = validUuid(oldId) ? oldId : randomUUID();
        await client.query(
          `insert into delivery_products(id,company_id,category,name,description,price,is_active,created_at,updated_at)
           values($1,$2,$3,$4,$5,$6,$7,coalesce($8::timestamptz,now()),now())
           on conflict(id) do update set category=excluded.category,name=excluded.name,description=excluded.description,
             price=excluded.price,is_active=excluded.is_active,updated_at=now()`,
          [id,companyId,cleanString(product.category)||null,cleanString(product.name),cleanString(product.description),Number(product.price)||0,product.is_active!==false,product.created_at||null]
        );
        if (oldId) productIdMap.set(oldId,id);
      }

      for (const variation of Array.isArray(payload.variations) ? payload.variations : []) {
        const productId = productIdMap.get(cleanString(variation.product_id)) || cleanString(variation.product_id);
        if (!validUuid(productId)) continue;
        const base = await client.query<{ price:number }>(`select price::float8 as price from delivery_products where id=$1 and company_id=$2`,[productId,companyId]);
        if (!base.rows[0]) continue;
        const absolute = Number(variation.price);
        if (!Number.isFinite(absolute)) continue;
        await client.query(
          `insert into product_variations(product_id,name,price_delta,is_active)
           values($1,$2,$3,true)`,
          [productId,cleanString(variation.name),Math.round((absolute-Number(base.rows[0].price))*100)/100]
        );
      }

      const customerIdMap = new Map<string,string>();
      for (const customer of Array.isArray(payload.customers) ? payload.customers : []) {
        const phone = cleanString(customer.phone_number).replace(/\D/g,'');
        if (!phone) continue;
        const oldId = cleanString(customer.id);
        const id = validUuid(oldId) ? oldId : randomUUID();
        const row = await client.query<{id:string}>(
          `insert into customers(id,company_id,name,phone_number,notes,default_address,favorite_payment,total_orders,total_spent,
             first_seen_at,last_seen_at,created_at,updated_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz,now()),coalesce($11::timestamptz,now()),coalesce($12::timestamptz,now()),now())
           on conflict(company_id,phone_number) do update set
             name=excluded.name,notes=coalesce(excluded.notes,customers.notes),default_address=coalesce(excluded.default_address,customers.default_address),
             favorite_payment=coalesce(excluded.favorite_payment,customers.favorite_payment),total_orders=greatest(customers.total_orders,excluded.total_orders),
             total_spent=greatest(customers.total_spent,excluded.total_spent),last_seen_at=greatest(customers.last_seen_at,excluded.last_seen_at),updated_at=now()
           returning id::text`,
          [id,companyId,cleanString(customer.name)||'Cliente',phone,cleanString(customer.notes)||null,cleanString(customer.default_address)||null,
           cleanString(customer.favorite_payment)||null,Number(customer.orders_count)||0,Number(customer.total_spent)||0,
           customer.first_order_at||customer.first_seen_at||null,customer.last_order_at||customer.last_seen_at||null,customer.created_at||null]
        );
        if (oldId) customerIdMap.set(oldId,row.rows[0]!.id);
      }

      for (const order of Array.isArray(payload.orders) ? payload.orders : []) {
        const oldId = cleanString(order.id);
        const id = validUuid(oldId) ? oldId : randomUUID();
        const customerId = customerIdMap.get(cleanString(order.customer_id)) || null;
        const items = Array.isArray(order.items) ? order.items : [];
        const type = order.delivery_type === 'pickup' ? 'pickup' : 'delivery';
        const method = ['pix','cash','card'].includes(cleanString(order.payment_method)) ? cleanString(order.payment_method) : 'pix';
        await client.query(
          `insert into delivery_orders(id,company_id,customer_id,client_name,client_phone,items,observations,delivery_type,delivery_address,
             total_value,status,payment_method,payment_status,change_for,payment_proof_url,payment_approved_at,delivered_at,created_at,updated_at,status_updated_at)
           values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17::timestamptz,coalesce($18::timestamptz,now()),coalesce($19::timestamptz,now()),coalesce($19::timestamptz,$18::timestamptz,now()))
           on conflict(id) do nothing`,
          [id,companyId,customerId,cleanString(order.client_name)||'Cliente',cleanString(order.client_phone).replace(/\D/g,''),JSON.stringify(items),cleanString(order.observations),
           type,cleanString(order.delivery_address),Number(order.total_value)||0,cleanString(order.status)||'Novos',method,cleanString(order.payment_status)||(method==='pix'?'pending':'pay_on_delivery'),
           order.change_for==null?null:Number(order.change_for),cleanString(order.payment_proof_url)||null,order.payment_approved_at||null,order.delivered_at||null,order.created_at||null,order.updated_at||null]
        );
      }

      for (const asset of Array.isArray(payload.menu_assets) ? payload.menu_assets : []) {
        const url=cleanString(asset.image_url || asset.asset_url); if(!url) continue;
        await client.query(
          `insert into menu_assets(company_id,page_number,asset_url,type,category,is_active,created_at)
           values($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz,now()))`,
          [companyId,Number(asset.page_number)||1,url,cleanString(asset.type)||'menu_page',cleanString(asset.category)||null,asset.is_active!==false,asset.created_at||null]
        );
      }

      const wa = payload.whatsapp;
      if (wa && cleanString(wa.instance_name)) {
        const instanceName = cleanString(wa.instance_name);
        await client.query(`update companies set evolution_instance=$2, whatsapp_completed=$3 where id=$1`,[companyId,instanceName,wa.status==='connected']);
        await client.query(
          `insert into whatsapp_connections(company_id,instance_name,instance_id,phone_number,status,connected_at,updated_at)
           values($1,$2,$3,$4,$5,$6::timestamptz,now())
           on conflict(company_id) do update set instance_name=excluded.instance_name,instance_id=excluded.instance_id,
             phone_number=excluded.phone_number,status=excluded.status,connected_at=excluded.connected_at,updated_at=now()`,
          [companyId,instanceName,cleanString(wa.instance_id)||null,cleanString(wa.phone_number)||null,cleanString(wa.status)||'disconnected',wa.connected_at||null]
        );
      }

      await client.query(`update companies set legacy_supabase_migrated=true, updated_at=now() where id=$1`,[companyId]);
      await client.query('commit');
      return { migrated: true };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async listProducts(companyId: string) {
    const result = await db.query(
      `select p.id::text, p.category, p.name, p.description,
              p.price::float8 as price, p.is_active, p.created_at, p.updated_at,
              coalesce((
                select jsonb_agg(
                  jsonb_build_object(
                    'id', v.id::text,
                    'name', v.name,
                    'price_delta', v.price_delta::float8,
                    'price', (p.price + v.price_delta)::float8,
                    'is_active', v.is_active
                  )
                  order by
                    case upper(v.name)
                      when 'P' then 1
                      when 'M' then 2
                      when 'G' then 3
                      when 'GG' then 4
                      else 10
                    end,
                    v.name
                )
                from product_variations v
                where v.product_id = p.id
              ), '[]'::jsonb) as variations
       from delivery_products p
       where p.company_id = $1
       order by p.category nulls last, p.name`,
      [companyId]
    );
    return result.rows;
  }

  async createProduct(companyId: string, body: Record<string, unknown>) {
    const price = Number(body.price);
    if (!cleanString(body.name) || !Number.isFinite(price) || price < 0) {
      throw new Error('Nome e preço válido são obrigatórios');
    }
    const result = await db.query(
      `insert into delivery_products (
         company_id, category, name, description, price, is_active
       ) values ($1, $2, $3, $4, $5, $6)
       returning id::text, category, name, description,
                 price::float8 as price, is_active, created_at, updated_at`,
      [
        companyId,
        cleanString(body.category) || null,
        cleanString(body.name),
        cleanString(body.description),
        price,
        body.is_active !== false
      ]
    );
    return result.rows[0];
  }

  async updateProduct(companyId: string, productId: string, body: Record<string, unknown>) {
    const current = await db.query(`select * from delivery_products where id = $1 and company_id = $2`, [productId, companyId]);
    const row = current.rows[0];
    if (!row) throw new Error('Produto não encontrado');

    const name = body.name === undefined ? row.name : cleanString(body.name);
    const category = body.category === undefined ? row.category : cleanString(body.category) || null;
    const description = body.description === undefined ? row.description : cleanString(body.description);
    const price = body.price === undefined ? Number(row.price) : Number(body.price);
    const active = body.is_active === undefined ? row.is_active : body.is_active !== false;

    if (!name || !Number.isFinite(price) || price < 0) throw new Error('Produto inválido');

    const result = await db.query(
      `update delivery_products
       set category = $3, name = $4, description = $5, price = $6,
           is_active = $7, updated_at = now()
       where id = $1 and company_id = $2
       returning id::text, category, name, description,
                 price::float8 as price, is_active, created_at, updated_at`,
      [productId, companyId, category, name, description, price, active]
    );
    return result.rows[0];
  }

  async deleteProduct(companyId: string, productId: string): Promise<void> {
    await db.query(`delete from delivery_products where id = $1 and company_id = $2`, [productId, companyId]);
  }

  async importMenu(companyId: string, categories: unknown[]) {
    const client = await db.connect();
    let imported = 0;
    try {
      await client.query('begin');
      for (const rawCategory of Array.isArray(categories) ? categories : []) {
        const category = cleanString((rawCategory as any)?.name);
        const products = Array.isArray((rawCategory as any)?.products)
          ? (rawCategory as any).products
          : [];
        if (!category) continue;

        for (const rawProduct of products) {
          if (rawProduct?.ignore === true) continue;
          const name = cleanString(rawProduct?.name);
          const rawPrice = rawProduct?.price;
          const price = rawPrice === null || rawPrice === undefined || rawPrice === ''
            ? Number.NaN
            : Number(rawPrice);
          if (!name || !Number.isFinite(price) || price < 0) {
            throw new Error(`Produto sem preço válido: ${name || 'sem nome'}`);
          }

          const existing = await client.query<{ id: string }>(
            `select id::text from delivery_products
             where company_id = $1 and lower(name) = lower($2)
             order by created_at asc limit 1`,
            [companyId, name]
          );

          let productId: string;
          if (existing.rows[0]) {
            productId = existing.rows[0].id;
            await client.query(
              `update delivery_products
               set category = $3, description = $4, price = $5,
                   is_active = $6, updated_at = now()
               where id = $1 and company_id = $2`,
              [productId, companyId, category, cleanString(rawProduct?.description), price, rawProduct?.available !== false]
            );
          } else {
            const inserted = await client.query<{ id: string }>(
              `insert into delivery_products (
                 company_id, category, name, description, price, is_active
               ) values ($1, $2, $3, $4, $5, $6)
               returning id::text`,
              [companyId, category, name, cleanString(rawProduct?.description), price, rawProduct?.available !== false]
            );
            productId = inserted.rows[0]!.id;
          }

          await client.query(`delete from product_variations where product_id = $1`, [productId]);
          for (const variation of Array.isArray(rawProduct?.variations) ? rawProduct.variations : []) {
            const variationName = cleanString(variation?.name);
            const variationPrice = Number(variation?.price);
            if (!variationName || !Number.isFinite(variationPrice)) continue;
            const delta = Math.round((variationPrice - price) * 100) / 100;
            await client.query(
              `insert into product_variations (product_id, name, price_delta, is_active)
               values ($1, $2, $3, true)`,
              [productId, variationName, delta]
            );
          }
          imported += 1;
        }
      }
      await client.query('commit');
      return { imported };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async getStoreInfo(companyId: string) {
    const result = await db.query(
      `select company_id::text, store_name, short_description, avg_time,
              min_order::float8 as min_order, opening_hours, delivery_fee,
              neighborhoods, payment_methods, pix_key, ai_rules, ai_enabled,
              updated_at
       from delivery_store_info where company_id = $1 limit 1`,
      [companyId]
    );
    return result.rows[0] ?? null;
  }

  async saveStoreInfo(companyId: string, body: Record<string, unknown>) {
    const result = await db.query(
      `insert into delivery_store_info (
         company_id, store_name, short_description, avg_time, min_order,
         opening_hours, delivery_fee, neighborhoods, payment_methods,
         pix_key, ai_rules, ai_enabled, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       on conflict (company_id) do update set
         store_name = excluded.store_name,
         short_description = excluded.short_description,
         avg_time = excluded.avg_time,
         min_order = excluded.min_order,
         opening_hours = excluded.opening_hours,
         delivery_fee = excluded.delivery_fee,
         neighborhoods = excluded.neighborhoods,
         payment_methods = excluded.payment_methods,
         pix_key = excluded.pix_key,
         ai_rules = excluded.ai_rules,
         ai_enabled = excluded.ai_enabled,
         updated_at = now()
       returning company_id::text, store_name, short_description, avg_time,
                 min_order::float8 as min_order, opening_hours, delivery_fee,
                 neighborhoods, payment_methods, pix_key, ai_rules, ai_enabled, updated_at`,
      [
        companyId,
        cleanString(body.store_name),
        cleanString(body.short_description),
        cleanString(body.avg_time),
        Number(body.min_order) || 0,
        cleanString(body.opening_hours),
        cleanString(body.delivery_fee),
        cleanString(body.neighborhoods),
        cleanString(body.payment_methods),
        cleanString(body.pix_key),
        cleanString(body.ai_rules),
        body.ai_enabled !== false
      ]
    );
    await db.query(`update companies set store_info_completed = true, updated_at = now() where id = $1`, [companyId]);
    return result.rows[0];
  }

  async getSettings(companyId: string) {
    const result = await db.query<{ config: Record<string, unknown>; instagram: string | null }>(
      `select coalesce(s.config, '{}'::jsonb) as config, c.instagram
       from companies c
       left join company_settings s on s.company_id = c.id
       where c.id = $1 limit 1`,
      [companyId]
    );
    const row = result.rows[0];
    return row ? { ...row.config, instagram: row.instagram ?? '' } : {};
  }

  async saveSettings(companyId: string, body: Record<string, unknown>) {
    const config = {
      display_name: cleanString(body.display_name),
      phone: cleanString(body.phone),
      email: cleanString(body.email),
      notifications_sound: body.notifications_sound !== false
    };
    const instagram = cleanString(body.instagram);
    await db.query(
      `insert into company_settings (company_id, config, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (company_id) do update set config = excluded.config, updated_at = now()`,
      [companyId, JSON.stringify(config)]
    );
    await db.query(`update companies set instagram = $2, updated_at = now() where id = $1`, [companyId, instagram || null]);
    return { ...config, instagram };
  }

  async listMenuAssets(companyId: string) {
    const result = await db.query(
      `select id::text, company_id::text, page_number,
              asset_url as image_url, type, category, is_active, created_at
       from menu_assets
       where company_id = $1 and is_active = true
       order by page_number asc, created_at asc`,
      [companyId]
    );
    return result.rows;
  }

  async replaceMenuAssets(companyId: string, inputPages: Array<string | Record<string, unknown>>) {
    if (!env.publicBaseUrl) throw new Error('PUBLIC_BASE_URL não configurada');
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(`delete from menu_assets where company_id = $1`, [companyId]);
      await client.query(`delete from media_files where company_id = $1 and kind = 'menu_asset'`, [companyId]);

      const assets = [];
      let fallbackPage = 0;
      for (const rawPage of inputPages) {
        const page = typeof rawPage === 'string' ? { base64: rawPage } : rawPage;
        const image = cleanString((page as any).base64 ?? (page as any).image ?? '');
        if (!image) continue;
        const { mimeType, bytes } = toBase64Payload(image);
        if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('Imagem de cardápio inválida');
        const media = await client.query<{ public_token: string }>(
          `insert into media_files (company_id, kind, mime_type, data, size_bytes)
           values ($1, 'menu_asset', $2, $3, $4)
           returning public_token::text`,
          [companyId, mimeType, bytes, bytes.length]
        );
        const url = `${env.publicBaseUrl}/media/${media.rows[0]!.public_token}`;
        const pageNumber = Number((page as any).page_number);
        const normalizedPage = Number.isFinite(pageNumber) ? pageNumber : fallbackPage;
        const asset = await client.query(
          `insert into menu_assets (company_id, page_number, asset_url, type, category, is_active)
           values ($1, $2, $3, 'menu_page', $4, true)
           returning id::text, company_id::text, page_number,
                     asset_url as image_url, type, category, is_active, created_at`,
          [companyId, normalizedPage, url, cleanString((page as any).category) || null]
        );
        assets.push(asset.rows[0]);
        fallbackPage += 1;
      }
      await client.query('commit');
      return assets;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async whatsappStatus(companyId: string) {
    const company = await db.query<{ evolution_instance: string }>(
      `select evolution_instance from companies where id = $1 limit 1`,
      [companyId]
    );
    const instanceName = company.rows[0]?.evolution_instance;
    if (!instanceName) return { status: 'disconnected', phoneNumber: null };

    const cached = await db.query(`select * from whatsapp_connections where company_id = $1 limit 1`, [companyId]);
    try {
      if (env.publicBaseUrl) {
        await evolution.setWebhook(instanceName, `${env.publicBaseUrl}/webhooks/evolution`).catch(() => undefined);
      }
      const state = await evolution.connectionState(instanceName);
      const rawState = state?.instance?.state;
      const status = rawState === 'open' ? 'connected' : rawState === 'connecting' ? 'connecting' : 'disconnected';
      const phoneNumber = state?.instance?.owner || cached.rows[0]?.phone_number || null;
      await db.query(
        `insert into whatsapp_connections (company_id, instance_name, phone_number, status, connected_at, updated_at)
         values ($1,$2,$3,$4,case when $4='connected' then now() else null end,now())
         on conflict (company_id) do update set
           phone_number = coalesce(excluded.phone_number, whatsapp_connections.phone_number),
           status = excluded.status,
           connected_at = case when excluded.status='connected' then coalesce(whatsapp_connections.connected_at, now()) else whatsapp_connections.connected_at end,
           updated_at = now()`,
        [companyId, instanceName, phoneNumber, status]
      );
      if (status === 'connected') {
        await db.query(`update companies set whatsapp_completed = true, updated_at = now() where id = $1`, [companyId]);
      }
      return { status, phoneNumber };
    } catch (error: any) {
      if (error?.status === 404) return { status: 'disconnected', phoneNumber: null };
      return { status: cached.rows[0]?.status || 'disconnected', phoneNumber: cached.rows[0]?.phone_number || null, degraded: true };
    }
  }

  async whatsappConnect(companyId: string) {
    const company = await db.query<{ evolution_instance: string }>(
      `select evolution_instance from companies where id = $1 limit 1`,
      [companyId]
    );
    const instanceName = company.rows[0]?.evolution_instance || deterministicInstance(companyId);
    const webhookUrl = env.publicBaseUrl ? `${env.publicBaseUrl}/webhooks/evolution` : '';

    let exists = true;
    let state: any = null;
    try {
      state = await evolution.connectionState(instanceName);
    } catch (error: any) {
      if (error?.status === 404) exists = false;
      else throw error;
    }

    if (state?.instance?.state === 'open') {
      const phoneNumber = state?.instance?.owner || null;
      await db.query(`update companies set whatsapp_completed = true, updated_at = now() where id = $1`, [companyId]);
      await db.query(
        `insert into whatsapp_connections (company_id, instance_name, phone_number, status, connected_at, updated_at)
         values ($1,$2,$3,'connected',now(),now())
         on conflict (company_id) do update set phone_number=excluded.phone_number,status='connected',connected_at=coalesce(whatsapp_connections.connected_at,now()),updated_at=now()`,
        [companyId, instanceName, phoneNumber]
      );
      return { success: true, status: 'connected', phoneNumber };
    }

    let qrCodeBase64: string | null = null;
    if (!exists) {
      const created = await evolution.createInstance(instanceName, webhookUrl);
      qrCodeBase64 = evolution.extractQr(created);
    }

    if (webhookUrl) await evolution.setWebhook(instanceName, webhookUrl).catch(() => undefined);
    if (!qrCodeBase64) qrCodeBase64 = evolution.extractQr(await evolution.connectInstance(instanceName));

    await db.query(
      `insert into whatsapp_connections (company_id, instance_name, status, updated_at)
       values ($1,$2,'connecting',now())
       on conflict (company_id) do update set instance_name=excluded.instance_name,status='connecting',updated_at=now()`,
      [companyId, instanceName]
    );
    await db.query(`update companies set evolution_instance = $2, updated_at = now() where id = $1`, [companyId, instanceName]);
    return { success: true, status: 'connecting', qrCodeBase64 };
  }

  async whatsappDisconnect(companyId: string) {
    const company = await db.query<{ evolution_instance: string }>(
      `select evolution_instance from companies where id = $1 limit 1`,
      [companyId]
    );
    const instanceName = company.rows[0]?.evolution_instance;
    if (instanceName) await evolution.logoutInstance(instanceName).catch(() => undefined);
    await db.query(
      `update whatsapp_connections set status='disconnected', phone_number=null, updated_at=now() where company_id=$1`,
      [companyId]
    );
    await db.query(`update companies set whatsapp_completed=false, updated_at=now() where id=$1`, [companyId]);
    return { success: true, status: 'disconnected' };
  }
}

export const panelService = new PanelService();
