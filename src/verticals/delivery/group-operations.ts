import { createHash, randomBytes } from 'node:crypto';
import { db } from '../../infrastructure/db.js';
import { redis } from '../../infrastructure/redis.js';
import { evolution } from '../../whatsapp/evolution.client.js';
import { norm, brl } from './helpers.js';
import { deliveryPostSaleService } from './post-sale.service.js';
import { updatePaymentStatus } from './repository.js';

function hash(token: string): string {
  return createHash('sha256').update(token.toUpperCase()).digest('hex');
}

export async function createGroupPairCode(companyId: string): Promise<string> {
  const code = randomBytes(10).toString('hex').toUpperCase();
  await db.query(
    `insert into delivery_operations(company_id,pairing_hash,pairing_expires_at)
     values($1,$2,now()+interval '10 minutes')
     on conflict(company_id) do update set
     pairing_hash=excluded.pairing_hash,
     pairing_expires_at=excluded.pairing_expires_at,updated_at=now()`,
    [companyId, hash(code)]
  );
  return code;
}

export async function groupConfiguration(companyId: string) {
  const result = await db.query(
    `select group_jid, manually_closed, menu_dirty
     from delivery_operations where company_id=$1`, [companyId]
  );
  return result.rows[0] ?? { group_jid: null, manually_closed: false, menu_dirty: false };
}

export async function isShopManuallyClosed(companyId: string): Promise<boolean> {
  const result = await db.query<{ manually_closed: boolean }>(
    'select manually_closed from delivery_operations where company_id=$1', [companyId]
  );
  return result.rows[0]?.manually_closed === true;
}

export async function notifyDeliveryGroup(
  companyId: string, text: string
): Promise<void> {
  const result = await db.query<{ group_jid: string; evolution_instance: string }>(
    `select ops.group_jid, c.evolution_instance from delivery_operations ops
     join companies c on c.id=ops.company_id
     where ops.company_id=$1 and ops.group_jid is not null and c.vertical='delivery'`,
    [companyId]
  );
  const row = result.rows[0];
  if (!row) return;
  await evolution.sendText({ instanceName: row.evolution_instance, to: row.group_jid, text });
}

type GroupIncoming = {
  instance: string; groupJid: string; actor: string; text: string; id: string; fromMe: boolean;
};

export function parseGroupIncoming(payload: any): GroupIncoming | null {
  const body = payload?.body ?? payload ?? {};
  const data = Array.isArray(body.data) ? body.data[0] : body.data ?? {};
  const info = data?.Info ?? data?.info ?? {};
  const key = data?.key ?? info?.key ?? {};
  const jidData = key?.remoteJid ?? data?.remoteJid ?? info?.Chat ?? info?.chat ?? '';
  const jid = typeof jidData === 'object' && jidData
    ? `${jidData.User ?? jidData.user}@${jidData.Server ?? jidData.server}`
    : String(jidData);
  if (!/^\d+@g\.us$/.test(jid)) return null;
  const actor = String(key?.participant ?? data?.participant ?? info?.Sender ?? info?.sender ?? '');
  const message = data?.message ?? data?.Message ?? {};
  const text = String(
    message?.conversation ?? message?.extendedTextMessage?.text ??
    message?.imageMessage?.caption ?? data?.text ?? ''
  ).trim();
  const instance = String(body?.instance_name ?? body?.instance ?? body?.instanceName ?? data?.instance ?? data?.instanceName ?? '');
  const id = String(key?.id ?? info?.ID ?? data?.id ?? '');
  const event = String(body?.event ?? '').toLowerCase().replace(/[_.]/g, '');
  if (event && !['messagesupsert','messageupsert'].includes(event)) return null;
  return instance && id && text ? {
    instance, groupJid: jid, actor, text, id,
    fromMe: key?.fromMe === true || data?.fromMe === true
  } : null;
}

async function findProduct(companyId: string, label: string) {
  const all = await db.query<{ id: string; name: string; price: number; is_active: boolean }>(
    `select id::text, name, price::float8 as price, is_active
     from delivery_products where company_id=$1`, [companyId]
  );
  const match = all.rows.filter(row => norm(row.name) === norm(label));
  return match.length === 1 ? match[0] : null;
}

async function resolveOrder(companyId: string, code: string) {
  const needle = code.replace(/^#/, '').toLowerCase();
  if (!/^[0-9a-f]{4,36}$/.test(needle)) return null;
  const res = await db.query<{ id: string; client_name: string; status: string }>(
    `select id::text, client_name, status from delivery_orders
     where company_id=$1 and id::text like $2 limit 2`, [companyId, needle + '%']
  );
  return res.rows.length === 1 ? res.rows[0] : null;
}

async function commands(companyId: string, group: GroupIncoming): Promise<string | null> {
  const raw = group.text.trim().replace(/^[/#]arles\s+/i, '');
  const cmd = norm(raw);
  if (/^(ajuda|comandos|menu)$/.test(cmd)) {
    return '🍔 *Arles Delivery*\n' +
      '• esgotou NOME / voltou NOME\n' +
      '• preço NOME 24,90 → confirmar preço\n' +
      '• #ABCD preparando | pronto | saiu | entregue | cancelado\n' +
      '• pix #ABCD aprovar\n' +
      '• fechar / abrir\n' +
      '• resumo / pendentes / cardápio';
  }
  if (/^(fechar|abrir)$/.test(cmd)) {
    await db.query(
      'update delivery_operations set manually_closed=$2,updated_at=now() where company_id=$1',
      [companyId, cmd === 'fechar']
    );
    return cmd === 'fechar' ? '🔴 Loja fechada excepcionalmente. Novos pedidos foram pausados.' :
      '🟢 Loja reaberta para novos pedidos.';
  }
  if (cmd === 'resumo') {
    const res = await db.query<{ count: string; total: string; pending: string }>(
      `select count(*)::text as count, coalesce(sum(total_value),0)::text as total,
       count(*) filter(where status in ('Novos','Em preparo','Pronto','Saiu para entrega'))::text as pending
       from delivery_orders where company_id=$1 and created_at >= (now() at time zone 'America/Bahia')::date
       and status <> 'Cancelados'`, [companyId]
    );
    const row = res.rows[0];
    return `📊 Hoje: ${row?.count || 0} pedidos • ${brl(Number(row?.total || 0))} • ${row?.pending || 0} em aberto.`;
  }
  if (cmd === 'pendentes') {
    const res = await db.query<{ id: string; status: string }>(
      `select id::text, status from delivery_orders
       where company_id=$1 and status in ('Novos','Em preparo','Pronto','Saiu para entrega')
       order by created_at asc limit 15`, [companyId]
    );
    return res.rows.length
      ? '📋 Pedidos em aberto:\n' + res.rows.map(x => `#${x.id.slice(0,6)} — ${x.status}`).join('\n')
      : '✅ Nenhum pedido em aberto.';
  }
  if (cmd === 'cardapio' || cmd === 'cardápio') {
    const res = await db.query<{ name: string; price: number }>(
      `select name, price::float8 as price from delivery_products
       where company_id=$1 and is_active=true order by category,name limit 60`, [companyId]
    );
    return res.rows.length
      ? '📋 Cardápio atual:\n' + res.rows.map(x => `• ${x.name} — ${brl(x.price)}`).join('\n')
      : 'Nenhum produto ativo no cardápio.';
  }
  let match = raw.match(/^(?:esgotou|acabou|desativar)\s+(.+)$/i);
  if (match) {
    const item = await findProduct(companyId, match[1]!);
    if (!item) return 'Produto não encontrado pelo nome exato. Use “cardápio” para consultar os nomes.';
    await db.query('update delivery_products set is_active=false,updated_at=now() where id=$1 and company_id=$2',[item.id,companyId]);
    await db.query('update delivery_operations set menu_dirty=true,updated_at=now() where company_id=$1',[companyId]);
    return `⛔ ${item.name} esgotado. Não será mais oferecido. Cardápio visual sinalizado para regeneração.`;
  }
  match = raw.match(/^(?:voltou|ativar|disponibilizar)\s+(.+)$/i);
  if (match) {
    const item = await findProduct(companyId, match[1]!);
    if (!item) return 'Produto não encontrado pelo nome exato. Use “cardápio” para consultar os nomes.';
    await db.query('update delivery_products set is_active=true,updated_at=now() where id=$1 and company_id=$2',[item.id,companyId]);
    await db.query('update delivery_operations set menu_dirty=true,updated_at=now() where company_id=$1',[companyId]);
    return `✅ ${item.name} voltou ao cardápio. Imagem visual sinalizada para atualização.`;
  }
  match = raw.match(/^pre[cç]o\s+(.+?)\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)$/i);
  if (match) {
    const item = await findProduct(companyId, match[1]!);
    if (!item) return 'Produto não encontrado pelo nome exato.';
    const price = Number(match[2]!.replace(',','.'));
    if (!(price > 0) || !Number.isFinite(price)) return 'Preço inválido.';
    const key = `arles:delivery:price:${companyId}:${group.groupJid}:${group.actor || 'owner'}`;
    await redis.set(key, JSON.stringify({ productId: item.id, price }), 'EX', 300);
    return `🧾 ${item.name}: ${brl(item.price)} → ${brl(price)}. Envie “confirmar preço” em até 5 minutos.`;
  }
  if (cmd === 'confirmar preco') {
    const key = `arles:delivery:price:${companyId}:${group.groupJid}:${group.actor || 'owner'}`;
    const saved = await redis.get(key);
    if (!saved) return 'Não há alteração de preço pendente ou ela expirou.';
    const pending = JSON.parse(saved) as { productId: string; price: number };
    await db.query('update delivery_products set price=$3,updated_at=now() where id=$1 and company_id=$2',
      [pending.productId, companyId, pending.price]);
    await db.query('update delivery_operations set menu_dirty=true,updated_at=now() where company_id=$1',[companyId]);
    await redis.del(key);
    return `✅ Preço alterado para ${brl(pending.price)}. Cardápio visual sinalizado para atualização.`;
  }
  match = raw.match(/^pix\s+#?([0-9a-f]{4,36})\s+aprovar$/i);
  if (match) {
    const order = await resolveOrder(companyId, match[1]!);
    if (!order) return 'Pedido não encontrado ou código ambíguo.';
    const saved = await updatePaymentStatus({ companyId, orderId: order.id, paymentStatus: 'approved' });
    return saved ? `✅ Pix do pedido #${order.id.slice(0,6)} aprovado.` : 'Pedido não encontrado.';
  }
  match = raw.match(/^#?([0-9a-f]{4,36})\s+(?:em\s+)?(preparando|preparo|pronto|saiu|entregue|cancelado)$/i);
  if (match) {
    const order = await resolveOrder(companyId, match[1]!);
    if (!order) return 'Pedido não encontrado ou código ambíguo.';
    const status = ({
      preparando:'Em preparo', preparo:'Em preparo', pronto:'Pronto', saiu:'Saiu para entrega',
      entregue:'Finalizados', cancelado:'Cancelados'
    } as Record<string,string>)[norm(match[2])] ?? 'Novos';
    const result = await deliveryPostSaleService.updateAndNotify({
      companyId, orderId: order.id, status
    });
    return `✅ Pedido #${order.id.slice(0,6)}: ${result.status}.`;
  }
  return null;
}

export async function handleDeliveryGroupMessage(payload: unknown): Promise<void> {
  const incoming = parseGroupIncoming(payload);
  if (!incoming) return;
  const company = await db.query<{ id: string; name: string }>(
    `select id::text, name from companies where evolution_instance=$1 and vertical='delivery' limit 1`,
    [incoming.instance]
  );
  const current = company.rows[0];
  if (!current) return;

  const dedupe = await redis.set(
    `arles:delivery:groupmsg:${current.id}:${incoming.id}`, '1', 'EX', 86400, 'NX'
  );
  if (dedupe !== 'OK') return;

  const pairing = incoming.text.match(/^[/#]?arles\s+vincular\s+([0-9A-F]{20})$/i);
  if (pairing) {
    const result = await db.query(
      `update delivery_operations set group_jid=$3,pairing_hash=null,pairing_expires_at=null,updated_at=now()
       where company_id=$1 and pairing_hash=$2 and pairing_expires_at > now()
       returning company_id`, [current.id, hash(pairing[1]!), incoming.groupJid]
    );
    if (result.rowCount) {
      await evolution.sendText({ instanceName: incoming.instance, to: incoming.groupJid,
        text: '✅ Grupo vinculado ao Arles Delivery. Envie “/arles ajuda” para ver os comandos.' });
    }
    return;
  }

  const ops = await groupConfiguration(current.id);
  if (ops.group_jid !== incoming.groupJid) return;
  // Never auto-reply to the bot's own notifications.
  if (incoming.fromMe && !/^[/#]?arles\s+/i.test(incoming.text)) return;
  // Commands are explicit or limited natural-language phrases in the linked group only.
  const requested = /^[/#]?arles\s+/i.test(incoming.text) ||
    /^(?:acabou|esgotou|voltou|ativar|desativar|pre[cç]o|confirmar pre[cç]o|fechar|abrir|resumo|pendentes|card[aá]pio|pix |#?[0-9a-f]{4,36}\s)/i.test(incoming.text);
  if (!requested) return;

  let response: string | null = null;
  try { response = await commands(current.id, incoming); }
  catch (error) {
    console.error('[Delivery grupo] comando falhou', error);
    response = 'Não foi possível concluir esse comando. Nenhuma confirmação foi enviada.';
  }
  if (response) await evolution.sendText({ instanceName: incoming.instance, to: incoming.groupJid, text: response });
}
