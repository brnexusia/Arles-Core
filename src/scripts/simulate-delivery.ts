import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { db } from '../infrastructure/db.js';
import { redis } from '../infrastructure/redis.js';
import { logIncoming, logOutgoing } from '../core/message.repository.js';
import { deliveryHandler } from '../verticals/delivery/handler.js';
import type { Company, NormalizedMessage } from '../core/types.js';

const DEMO_SLUG = 'delivery-demo';
const DEMO_PHONE = '5511999990001';

async function loadCompany(): Promise<Company> {
  const result = await db.query<Company>(
    `
    select
      id,
      name,
      slug,
      vertical,
      evolution_instance,
      subscription_status,
      access_active,
      trial_ends_at,
      timezone
    from companies
    where slug = $1
    limit 1
    `,
    [DEMO_SLUG]
  );

  const company = result.rows[0];

  if (!company) {
    throw new Error(
      'Delivery demo não encontrado. Execute primeiro: npm run seed:delivery'
    );
  }

  return company;
}

async function resetConversation(companyId: string): Promise<void> {
  await db.query(
    `
    delete from conversation_sessions
    where company_id = $1
      and phone_number = $2
    `,
    [companyId, DEMO_PHONE]
  );

  await redis.del(
    `arles:recent-confirmed:${companyId}:${DEMO_PHONE}`,
    `arles:buffer:${companyId}:${DEMO_PHONE}`,
    `arles:lock:${companyId}:${DEMO_PHONE}`
  );
}

async function freshCustomer(companyId: string): Promise<void> {
  await resetConversation(companyId);

  await db.query(
    `
    delete from delivery_orders
    where company_id = $1
      and client_phone = $2
    `,
    [companyId, DEMO_PHONE]
  );

  await db.query(
    `
    delete from customers
    where company_id = $1
      and phone_number = $2
    `,
    [companyId, DEMO_PHONE]
  );
}

async function showOrders(companyId: string): Promise<void> {
  const result = await db.query<{
    id: string;
    client_name: string;
    total_value: string;
    status: string;
    payment_method: string;
    created_at: Date;
  }>(
    `
    select
      id::text,
      client_name,
      total_value::text,
      status,
      payment_method,
      created_at
    from delivery_orders
    where company_id = $1
      and client_phone = $2
    order by created_at desc
    limit 5
    `,
    [companyId, DEMO_PHONE]
  );

  if (!result.rows.length) {
    console.log('\nNenhum pedido simulado ainda.\n');
    return;
  }

  console.log('\nÚltimos pedidos simulados:');

  for (const order of result.rows) {
    console.log(
      `- ${order.id.slice(0, 8)} | ${order.client_name} | ` +
      `R$ ${Number(order.total_value).toFixed(2)} | ` +
      `${order.payment_method} | ${order.status}`
    );
  }

  console.log('');
}

function fakeMessage(
  company: Company,
  text: string,
  sequence: number
): NormalizedMessage {
  const jid = `${DEMO_PHONE}@s.whatsapp.net`;

  return {
    messageId: `sim-${Date.now()}-${sequence}`,
    instanceName: company.evolution_instance,
    remoteJid: jid,
    replyJid: jid,
    phone: DEMO_PHONE,
    pushName: '',
    fromMe: false,
    isGroup: false,
    isBroadcast: false,
    event: 'MESSAGES_UPSERT',
    type: 'text',
    text,
    raw: {
      simulator: true,
      text
    }
  };
}

async function run(): Promise<void> {
  const company = await loadCompany();
  const rl = createInterface({ input, output });

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' ARLES ENGINE — SIMULADOR DELIVERY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` Empresa: ${company.name}`);
  console.log(` Telefone simulado: ${DEMO_PHONE}`);
  console.log('');
  console.log(' Comandos:');
  console.log(' /reset   limpa somente a conversa atual');
  console.log(' /fresh   limpa conversa + cliente + pedidos simulados');
  console.log(' /orders  mostra os últimos pedidos');
  console.log(' /exit    encerra');
  console.log('');
  console.log(' Sugestão para começar: quero uma vegetariana');
  console.log('');

  let sequence = 0;

  while (true) {
    const text = (await rl.question('CLIENTE > ')).trim();

    if (!text) continue;

    if (text === '/exit') {
      break;
    }

    if (text === '/reset') {
      await resetConversation(company.id);
      console.log('ARLES   > conversa limpa ✅\n');
      continue;
    }

    if (text === '/fresh') {
      await freshCustomer(company.id);
      console.log('ARLES   > ambiente do cliente simulado zerado ✅\n');
      continue;
    }

    if (text === '/orders') {
      await showOrders(company.id);
      continue;
    }

    sequence += 1;
    const message = fakeMessage(company, text, sequence);

    await logIncoming({
      companyId: company.id,
      phone: message.phone,
      messageId: message.messageId,
      messageType: 'text',
      body: text,
      rawPayload: message.raw
    });

    const response = await deliveryHandler.handle({
      company,
      message,
      combinedText: text
    });

    if (!response || !response.actions.length) {
      console.log('ARLES   > [sem resposta]\n');
      continue;
    }

    console.log('');

    for (const action of response.actions) {
      if (action.type === 'text') {
        await logOutgoing({
          companyId: company.id,
          phone: message.phone,
          body: action.text
        });
        console.log(`ARLES   > ${action.text.replace(/\n/g, '\n          ')}`);
      } else {
        console.log(`ARLES   > [imagem] ${action.mediaUrl}`);
      }
    }

    if (response.followupEligible) {
      console.log('ARLES   > [follow-up elegível em 30 min]');
    }

    if (response.pauseSeconds) {
      console.log(`ARLES   > [transbordo/pausa por ${response.pauseSeconds}s]`);
    }

    console.log('');
  }

  rl.close();
  await redis.quit();
  await db.end();

  console.log('\nSimulador encerrado.\n');
}

try {
  await run();
} catch (error) {
  console.error('\n❌ Erro no simulador:', error);
  await redis.quit().catch(() => undefined);
  await db.end().catch(() => undefined);
  process.exit(1);
}
