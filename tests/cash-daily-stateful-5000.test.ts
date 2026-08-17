import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Company, NormalizedMessage } from '../src/core/types.js';
import type { VerticalContext, VerticalResult } from '../src/verticals/vertical.js';

let db: (typeof import('../src/infrastructure/db.js'))['db'];
let redis: (typeof import('../src/infrastructure/redis.js'))['redis'];
let cashModule: (typeof import('../src/verticals/cash/module.js'))['cashModule'];

type SyntheticUser = {
  index: number;
  phone: string;
  company: Company;
};

type Step = {
  text: string;
  expect?: RegExp;
  reject?: RegExp;
};

const USER_COUNT = 100;
const MESSAGE_COUNT = 50;
const SYNTHETIC_PREFIX = 'cash-synthetic-eval-';

const script: Step[] = [
  { text: 'oi', expect: /oi|olá/i },
  { text: 'recebi 1000 de salário', expect: /confirma|antes de registrar/i },
  { text: 'sim', expect: /lançamento registrado/i },
  { text: 'gastei 120 no mercado', expect: /confirma|antes de registrar/i },
  { text: 'sim', expect: /lançamento registrado/i },
  { text: 'saldo', expect: /880,00/ },
  { text: 'quanto gastei hoje?', expect: /120,00/ },
  { text: 'meus registros', expect: /120,00|1\.000,00/ },
  { text: "Criar cofrinho chamado 'Viagem'. Criar cofrinho chamado 'Reserva'. Criar cofrinho chamado 'Casa'", expect: /Viagem[\s\S]*Reserva[\s\S]*Casa|3 cofrinhos/i, reject: /Viagem.*Criar cofrinho chamado/i },
  { text: 'meus cofrinhos', expect: /Viagem[\s\S]*Reserva[\s\S]*Casa|Casa[\s\S]*Reserva[\s\S]*Viagem/i, reject: /Criar cofrinho chamado/i },
  { text: 'apaga eles pfv', expect: /3 cofrinhos apagados/i, reject: /lançamento financeiro foi apagado|nenhum lançamento/i },
  { text: 'meus cofrinhos', expect: /ainda não tem cofrinhos|não tem cofrinhos/i },
  { text: 'cria um cofrinho chamado Viagem', expect: /Viagem/i },
  { text: 'guardei 200 no cofrinho Viagem', expect: /confirma|antes de registrar/i },
  { text: 'sim', expect: /lançamento registrado/i },
  { text: 'saldo do cofrinho Viagem', expect: /Viagem/i },
  { text: 'quanto tenho', expect: /seu saldo disponível|saldo disponível/i, reject: /Cofrinho|Seus cofrinhos/i },
  { text: 'apaga ele', expect: /Cofrinho.*Viagem.*apagado/i, reject: /nenhum lançamento financeiro foi apagado/i },
  { text: 'saldo', expect: /680,00/ },
  { text: 'se eu gastar 80 quanto fica?', expect: /600,00/ },
  { text: 'saldo', expect: /680,00/ },
  { text: 'não registra, só calcula: se eu receber 100 quanto fica?', expect: /780,00/ },
  { text: 'saldo', expect: /680,00/ },
  { text: 'amanhã vou pagar 90 de luz', expect: /previs|agend|amanhã/i },
  { text: 'saldo', expect: /680,00/ },
  { text: 'todo mês recebo 500 de freela', expect: /previs|agend|mensal|todo mês/i },
  { text: 'saldo', expect: /680,00/ },
  { text: 'gastei 30 na farmácia', expect: /confirma|antes de registrar/i },
  { text: 'não', expect: /não registrei nada/i },
  { text: 'saldo', expect: /680,00/ },
  { text: 'gastei 50 no uber', expect: /confirma|antes de registrar/i },
  { text: 'o valor foi 55', expect: /55,00|ajust/i },
  { text: 'sim', expect: /lançamento registrado/i },
  { text: 'saldo', expect: /625,00/ },
  { text: 'fala meus registros aí', expect: /55,00|200,00|120,00|1\.000,00/ },
  { text: 'apaga o último lançamento', expect: /apag|exclu|remov/i },
  { text: 'desfaz', expect: /restaur|recuper|desf|coloc/i },
  { text: 'saldo', expect: /625,00/ },
  { text: 'relatório semanal', expect: /semana|semanal/i },
  { text: 'relatório mensal', expect: /mês|mensal/i },
  { text: 'categorias', expect: /categor/i },
  { text: 'planos', expect: /mensal|trimestral|anual/i },
  { text: 'trial', expect: /trial|gratuit|dias/i },
  { text: 'ajuda', expect: /gasto|saldo|cofrinho|ajuda/i },
  { text: 'recebi 250 de freela; gastei 40 no almoço', expect: /2 lançamentos|confirma estes 2/i },
  { text: 'sim', expect: /2 lançamentos registrados/i },
  { text: 'quanto recebi esse mês?', expect: /receb|entrada|1\.250,00|1.250,00/i },
  { text: 'me mostra tudo que saiu hoje', expect: /saída|saidas|despesa|gasto|415,00|415/i },
  { text: 'qual foi a compra mais cara hoje?', expect: /200,00|maior|cara/i },
  { text: 'me fala meu saldo atual por favor', expect: /835,00|saldo disponível/i }
];

function plain(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function resultText(result: VerticalResult | null | undefined): string {
  if (!result) return '';
  return plain(result.actions
    .filter(action => action.type === 'text')
    .map(action => action.type === 'text' ? action.text : '')
    .join('\n'));
}

function contextFor(user: SyntheticUser, text: string, step: number): VerticalContext {
  const message: NormalizedMessage = {
    messageId: `synthetic-${user.index}-${step}`,
    instanceName: `synthetic-instance-${user.index}`,
    remoteJid: `${user.phone}@s.whatsapp.net`,
    replyJid: `${user.phone}@s.whatsapp.net`,
    phone: user.phone,
    pushName: `Pessoa ${user.index}`,
    fromMe: false,
    isGroup: false,
    isBroadcast: false,
    event: 'messages.upsert',
    type: 'text',
    text,
    raw: { synthetic: true, user: user.index, step }
  };
  return { company: user.company, message, combinedText: text };
}

async function send(user: SyntheticUser, text: string, step: number): Promise<string> {
  const context = contextFor(user, text, step);
  const pending = cashModule.handlePendingInteraction
    ? await cashModule.handlePendingInteraction(context)
    : undefined;
  const result = pending ?? await cashModule.handle(context);
  return resultText(result);
}

async function seedSyntheticUsers(): Promise<SyntheticUser[]> {
  await db.query(`delete from companies where slug like $1`, [`${SYNTHETIC_PREFIX}%`]);
  await redis.flushdb();

  const users: SyntheticUser[] = [];
  for (let index = 1; index <= USER_COUNT; index += 1) {
    const phone = `550000${String(index).padStart(7, '0')}`;
    const slug = `${SYNTHETIC_PREFIX}${index}`;
    const created = await db.query<{ id: string }>(
      `insert into companies(
         name,slug,vertical,evolution_instance,subscription_status,access_active,
         trial_started_at,trial_ends_at,timezone
       ) values($1,$2,'cash',$3,'trial',true,now(),now()+interval '7 days','America/Sao_Paulo')
       returning id::text`,
      [`Pessoa Sintética ${index}`, slug, `synthetic-instance-${index}`]
    );
    const id = created.rows[0]!.id;
    await db.query(
      `insert into cash_settings(
         company_id,owner_phone,owner_name,owner_email,onboarding_state,onboarding_completed_at,
         weekly_report_enabled,monthly_report_enabled
       ) values($1,$2,$3,$4,'active',now(),true,true)`,
      [id, phone, `Pessoa ${index}`, `pessoa${index}@example.invalid`]
    );

    users.push({
      index,
      phone,
      company: {
        id,
        name: `Pessoa Sintética ${index}`,
        slug,
        vertical: 'cash',
        evolution_instance: `synthetic-instance-${index}`,
        subscription_status: 'trial',
        access_active: true,
        trial_ends_at: new Date(Date.now() + 7 * 86_400_000),
        timezone: 'America/Sao_Paulo'
      }
    });
  }
  return users;
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.OPENAI_API_KEY = '';
  ({ db } = await import('../src/infrastructure/db.js'));
  ({ redis } = await import('../src/infrastructure/redis.js'));
  ({ cashModule } = await import('../src/verticals/cash/module.js'));
});

afterAll(async () => {
  if (db) {
    await db.query(`delete from companies where slug like $1`, [`${SYNTHETIC_PREFIX}%`]);
    await db.end();
  }
  if (redis) {
    await redis.flushdb();
    redis.disconnect();
  }
});

describe('Arles Cash — 100 usuários sintéticos x 50 mensagens encadeadas', () => {
  it('simula 5.000 interações diárias com estado, isolamento e sem serviços reais', async () => {
    expect(script).toHaveLength(MESSAGE_COUNT);
    const users = await seedSyntheticUsers();
    const failures: Array<{ user: number; step: number; input: string; output: string; reason: string }> = [];
    let executed = 0;

    for (const user of users) {
      for (let stepIndex = 0; stepIndex < script.length; stepIndex += 1) {
        const step = script[stepIndex]!;
        let output = '';
        try {
          output = await send(user, step.text, stepIndex + 1);
          if (!output) {
            failures.push({ user: user.index, step: stepIndex + 1, input: step.text, output, reason: 'resposta vazia' });
          } else if (step.expect && !step.expect.test(output)) {
            failures.push({ user: user.index, step: stepIndex + 1, input: step.text, output, reason: `não corresponde a ${step.expect}` });
          } else if (step.reject && step.reject.test(output)) {
            failures.push({ user: user.index, step: stepIndex + 1, input: step.text, output, reason: `contém padrão proibido ${step.reject}` });
          }
        } catch (error) {
          failures.push({
            user: user.index,
            step: stepIndex + 1,
            input: step.text,
            output,
            reason: error instanceof Error ? error.message : String(error)
          });
        }
        executed += 1;
      }
    }

    const crossUser = await db.query<{ companies: number; phones: number; total: number }>(
      `select
         count(distinct company_id)::int as companies,
         count(distinct user_phone)::int as phones,
         count(*)::int as total
       from cash_transactions ct
       join companies c on c.id=ct.company_id
       where c.slug like $1`,
      [`${SYNTHETIC_PREFIX}%`]
    );

    expect(executed).toBe(USER_COUNT * MESSAGE_COUNT);
    expect(Number(crossUser.rows[0]?.companies ?? 0)).toBe(USER_COUNT);
    expect(Number(crossUser.rows[0]?.phones ?? 0)).toBe(USER_COUNT);
    expect(failures, `Falhas stateful: ${JSON.stringify(failures.slice(0, 40), null, 2)}`).toEqual([]);
  }, 180_000);
});
