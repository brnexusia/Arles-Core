import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  isCashDirectBalanceRequest,
  isCashHypotheticalOrCalculation,
  isCashProtectedNonTransaction,
  parseCashProjection
} = await import('../src/verticals/cash/ledger.js');
const { deterministicCashParse } = await import('../src/verticals/cash/parser.js');
const { parseCashPocketCommand } = await import('../src/verticals/cash/cofrinhos.js');
const {
  normalizeEvolutionEditedMessage
} = await import('../src/whatsapp/normalize.js');
const { EVOLUTION_WEBHOOK_EVENTS } = await import('../src/whatsapp/evolution.client.js');

function projected(base: number, operations: Array<{ type: 'income' | 'expense'; amount: number }>): number {
  return Math.round(operations.reduce((value, operation) =>
    operation.type === 'income' ? value + operation.amount : value - operation.amount, base) * 100) / 100;
}

describe('cash deterministic ledger routes', () => {
  it('resolve o caso crítico de saldo 10 menos 5,67 sem criar despesa de 10', () => {
    const input = 'tenho saldo de 10, se eu gastar 5,67 quanto que ficará disponível no meu saldo depois do gasto?';
    const projection = parseCashProjection(input);

    expect(isCashHypotheticalOrCalculation(input)).toBe(true);
    expect(isCashProtectedNonTransaction(input)).toBe(true);
    expect(deterministicCashParse(input)).toBeNull();
    expect(projection?.explicitBase).toBe(10);
    expect(projection?.operations).toEqual([{ type: 'expense', amount: 5.67 }]);
    expect(projected(projection!.explicitBase!, projection!.operations)).toBe(4.33);
  });

  it('reconhece centenas de variações de simulação de gasto sem registrar', () => {
    const bases = [
      'tenho saldo de 100',
      'estou com saldo de 100',
      'meu saldo é 100',
      'saldo atual é 100',
      'partindo de saldo de 100'
    ];
    const verbs = ['gastar', 'pagar', 'comprar', 'usar', 'retirar', 'descontar'];
    const endings = [
      'quanto fica?',
      'quanto ficaria meu saldo?',
      'quanto sobra?',
      'qual saldo restaria?',
      'quanto eu teria?',
      'quanto vai sobrar?'
    ];

    let count = 0;
    for (const base of bases) {
      for (const verb of verbs) {
        for (const ending of endings) {
          const input = `${base}, se eu ${verb} 12,34, ${ending}`;
          expect(isCashProtectedNonTransaction(input), input).toBe(true);
          expect(deterministicCashParse(input), input).toBeNull();
          const projection = parseCashProjection(input);
          expect(projection?.explicitBase, input).toBe(100);
          expect(projection?.operations.some(item => item.type === 'expense' && item.amount === 12.34), input).toBe(true);
          count += 1;
        }
      }
    }
    expect(count).toBe(180);
  });

  it('reconhece centenas de variações de simulação de entrada sem registrar', () => {
    const bases = ['tenho saldo de 50', 'estou com saldo de 50', 'meu saldo é 50', 'saldo atual é 50'];
    const verbs = ['receber', 'ganhar', 'entrar', 'cair', 'vender'];
    const endings = ['quanto fica?', 'quanto terei?', 'qual fica meu saldo?', 'quanto teria?', 'quanto vai ficar?'];

    let count = 0;
    for (const base of bases) {
      for (const verb of verbs) {
        for (const ending of endings) {
          const phrase = ['entrar', 'cair'].includes(verb)
            ? `${base}, se ${verb} 25, ${ending}`
            : `${base}, se eu ${verb} 25, ${ending}`;
          expect(isCashProtectedNonTransaction(phrase), phrase).toBe(true);
          expect(deterministicCashParse(phrase), phrase).toBeNull();
          expect(parseCashProjection(phrase)?.operations.some(item => item.type === 'income' && item.amount === 25), phrase).toBe(true);
          count += 1;
        }
      }
    }
    expect(count).toBe(100);
  });

  it('reconhece dezenas de formas diretas de perguntar saldo sem IA', () => {
    const heads = ['saldo', 'meu saldo', 'saldo atual', 'quanto tenho', 'quanto eu tenho', 'quanto tem', 'quanto que tem', 'qual é meu saldo'];
    const punctuation = ['', '?', '!', '??'];
    let count = 0;
    for (const head of heads) {
      for (const tail of punctuation) {
        expect(isCashDirectBalanceRequest(`${head}${tail}`), `${head}${tail}`).toBe(true);
        expect(deterministicCashParse(`${head}${tail}`), `${head}${tail}`).toBeNull();
        count += 1;
      }
    }
    expect(count).toBe(32);
  });

  it('não bloqueia lançamentos reais claros', () => {
    const real = [
      'gastei 90 no mercado',
      'paguei 5,67 no café',
      'recebi 100 de freela',
      'ganhei 50 hoje',
      'comprei uma blusa por 30',
      'guardei 20 na reserva'
    ];
    for (const input of real) {
      expect(isCashProtectedNonTransaction(input), input).toBe(false);
      expect(deterministicCashParse(input), input).not.toBeNull();
    }
  });
});

describe('cash pocket routes', () => {
  it('reconhece várias formas de criar cofrinhos', () => {
    const verbs = ['criar', 'cria', 'crie', 'abre', 'faz'];
    const names = ['Emprego', 'Casa', 'Viagem', 'Faculdade', 'Reserva 2026'];
    let count = 0;
    for (const verb of verbs) {
      for (const name of names) {
        const parsed = parseCashPocketCommand(`${verb} um cofrinho ${name}`);
        expect(parsed, `${verb} ${name}`).toMatchObject({ kind: 'create', name });
        count += 1;
      }
    }
    expect(count).toBe(25);
  });

  it('separa consulta de cofrinho de lançamento dentro do cofrinho', () => {
    expect(parseCashPocketCommand('quanto gastei no cofrinho Emprego')).toEqual({
      kind: 'flow', name: 'Emprego', type: 'expense'
    });
    expect(parseCashPocketCommand('quanto recebi no cofrinho Emprego')).toEqual({
      kind: 'flow', name: 'Emprego', type: 'income'
    });
    expect(parseCashPocketCommand('extrato do cofrinho Emprego')).toEqual({ kind: 'statement', name: 'Emprego', type: undefined });
    expect(parseCashPocketCommand('gastei 30 do cofrinho Emprego')).toBeNull();
    expect(parseCashPocketCommand('recebi 500 no cofrinho Emprego')).toBeNull();
  });
});

describe('cash edited WhatsApp messages', () => {
  it('assina os dois eventos de edição/update da Evolution', () => {
    expect(EVOLUTION_WEBHOOK_EVENTS).toContain('MESSAGES_EDITED');
    expect(EVOLUTION_WEBHOOK_EVENTS).toContain('MESSAGES_UPDATE');
  });

  it('normaliza editedMessage dentro de MESSAGES_UPDATE e mantém o id original', () => {
    const message = normalizeEvolutionEditedMessage({
      event: 'messages.update',
      instance: 'arles-cash',
      data: {
        key: {
          id: 'original-123',
          remoteJid: '5575999999999@s.whatsapp.net',
          fromMe: false
        },
        update: {
          message: {
            editedMessage: {
              message: { conversation: 'gastei 35 no mercado' }
            }
          }
        }
      }
    });

    expect(message?.isEdit).toBe(true);
    expect(message?.editedMessageId).toBe('original-123');
    expect(message?.text).toBe('gastei 35 no mercado');
    expect(message?.phone).toBe('5575999999999');
  });

  it('ignora MESSAGES_UPDATE que é apenas status/ack', () => {
    const message = normalizeEvolutionEditedMessage({
      event: 'messages.update',
      instance: 'arles-cash',
      data: {
        messageId: 'abc',
        remoteJid: '5575999999999@s.whatsapp.net',
        status: 'READ'
      }
    });
    expect(message).toBeNull();
  });
});
