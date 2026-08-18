import { beforeAll, describe, expect, it } from 'vitest';

let normalizeCashPocketLanguage: (input: string) => string;
let parseCashPocketReceivableIntent: (input: string) =>
  | { kind: 'create'; amount: number; debtor: string | null }
  | { kind: 'list' }
  | { kind: 'cancel'; amount: number | null }
  | null;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
  process.env.EVOLUTION_BASE_URL ||= 'http://127.0.0.1:8080';
  process.env.EVOLUTION_API_KEY ||= 'test';
  ({ normalizeCashPocketLanguage } = await import('../src/verticals/cash/pocket-language.js'));
  ({ parseCashPocketReceivableIntent } = await import('../src/verticals/cash/pocket-receivables.js'));
});

describe('Cash cofre/cofrinho e valores a receber', () => {
  it('normaliza cofre para cofrinho antes do roteamento', () => {
    expect(normalizeCashPocketLanguage('saldo do cofre Vendas')).toBe('saldo do cofrinho Vendas');
    expect(normalizeCashPocketLanguage('meus cofres')).toBe('meus cofrinhos');
  });

  it('entende exatamente a frase do print como valor a receber no cofrinho', () => {
    expect(parseCashPocketReceivableIntent('Quero que você registre no cofre vendas, tenho que cobrar 110,00')).toEqual({
      kind: 'create',
      amount: 110,
      debtor: null
    });
  });

  it('entende a segunda frase do print', () => {
    expect(parseCashPocketReceivableIntent('Coloque no essas informações no cofre vendas, falta cobrar 110,00 para fechar o caixa')).toEqual({
      kind: 'create',
      amount: 110,
      debtor: null
    });
  });

  it.each([
    'falta cobrar R$ 250 no cofrinho Vendas',
    'tenho R$ 250 a receber no cofre Vendas',
    'preciso cobrar 250 no cofrinho Vendas',
    'cliente ficou devendo 250 no cofrinho Vendas'
  ])('registra linguagem natural de pendência: %s', input => {
    const intent = parseCashPocketReceivableIntent(input);
    expect(intent?.kind).toBe('create');
    if (intent?.kind === 'create') expect(intent.amount).toBe(250);
  });

  it('extrai devedor quando ele está explícito', () => {
    expect(parseCashPocketReceivableIntent('falta cobrar 180 de João no cofrinho Vendas')).toEqual({
      kind: 'create',
      amount: 180,
      debtor: 'João'
    });
  });

  it('consulta pendências sem transformar pergunta em novo registro', () => {
    expect(parseCashPocketReceivableIntent('quanto falta cobrar no cofre Vendas?')).toEqual({ kind: 'list' });
    expect(parseCashPocketReceivableIntent('o que tenho a receber?')).toEqual({ kind: 'list' });
  });

  it('não confunde dinheiro já recebido com pendência', () => {
    expect(parseCashPocketReceivableIntent('recebi 110 que faltava cobrar no cofre Vendas')).toBeNull();
  });

  it('entende cancelamento da pendência', () => {
    expect(parseCashPocketReceivableIntent('cancela o valor a receber de 110 no cofre Vendas')).toEqual({
      kind: 'cancel',
      amount: 110
    });
  });
});
