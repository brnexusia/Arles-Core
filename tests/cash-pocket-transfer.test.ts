import { beforeAll, describe, expect, it } from 'vitest';

let parseCashPocketTransferIntent: (input: string) => {
  direction: 'in' | 'out';
  amount: number;
  simulation: boolean;
} | null;
let parseCashPocketCommand: (input: string) => unknown;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
  process.env.EVOLUTION_BASE_URL ||= 'http://127.0.0.1:8080';
  process.env.EVOLUTION_API_KEY ||= 'test';
  ({ parseCashPocketTransferIntent } = await import('../src/verticals/cash/pocket-transfer.js'));
  ({ parseCashPocketCommand } = await import('../src/verticals/cash/cofrinhos.js'));
});

describe('Cash pocket reserves', () => {
  it('entende guardar dinheiro no cofrinho como alocação, não criação nem despesa', () => {
    expect(parseCashPocketTransferIntent('Quero guardar 450,00 no cofrinho Sonho')).toEqual({
      direction: 'in',
      amount: 450,
      simulation: false
    });
  });

  it.each([
    'coloca R$ 120 no cofrinho Sonho',
    'bota 120 no cofrinho Sonho',
    'separa 120 no cofrinho Sonho',
    'reserva 120 no cofrinho Sonho',
    'transfere 120 para o cofrinho Sonho',
    'guarda 120 na caixinha Sonho',
    'coloca 120 no envelope Sonho',
    'bota 120 no potinho Sonho',
    'separa 120 no porquinho Sonho'
  ])('aceita linguagem natural para guardar: %s', input => {
    expect(parseCashPocketTransferIntent(input)?.direction).toBe('in');
    expect(parseCashPocketTransferIntent(input)?.amount).toBe(120);
  });

  it.each([
    'tira 100 do cofrinho Sonho',
    'retira 100 do cofrinho Sonho',
    'resgata 100 do cofrinho Sonho',
    'transfere 100 do cofrinho Sonho',
    'tira 100 da caixinha Sonho',
    'libera 100 do envelope Sonho'
  ])('aceita linguagem natural para liberar: %s', input => {
    expect(parseCashPocketTransferIntent(input)?.direction).toBe('out');
    expect(parseCashPocketTransferIntent(input)?.amount).toBe(100);
  });

  it('trata a frase do print como simulação de reserva e nunca como cofrinho chamado quero guardar', () => {
    const input = 'Quero colocar 450,00 no cofrinho. Se eu colocar esse no confronto quanto vou ter disponível, sem inclui esse do confrinho? Porque o do cofrinho quero guardar';
    expect(parseCashPocketTransferIntent(input)).toEqual({
      direction: 'in',
      amount: 450,
      simulation: true
    });
    expect(parseCashPocketCommand(input)).toBeNull();
  });

  it('não confunde gasto real do cofrinho com transferência interna', () => {
    expect(parseCashPocketTransferIntent('gastei 30 do cofrinho Sonho')).toBeNull();
    expect(parseCashPocketTransferIntent('recebi 500 no cofrinho Sonho')).toBeNull();
  });

  it('não executa recorrência futura como reserva imediata', () => {
    expect(parseCashPocketTransferIntent('todo mês quero guardar 450 no cofrinho Sonho')).toBeNull();
  });

  it('entende pergunta de projeção da reserva', () => {
    expect(parseCashPocketTransferIntent('se eu guardar 450 no cofrinho Sonho quanto vou ter disponível?')).toEqual({
      direction: 'in',
      amount: 450,
      simulation: true
    });
  });

  it('entende erro comum de digitação do nome cofrinho', () => {
    expect(parseCashPocketTransferIntent('se eu colocar 450 no confrinho Sonho quanto fica disponível?')).toEqual({
      direction: 'in',
      amount: 450,
      simulation: true
    });
  });
});
