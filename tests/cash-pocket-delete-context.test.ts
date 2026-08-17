import { beforeAll, describe, expect, it } from 'vitest';

let parseCashPocketDeleteReference: (input: string) => { kind: 'explicit' | 'context' | 'context-all' } | null;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
  process.env.EVOLUTION_BASE_URL ||= 'http://127.0.0.1:8080';
  process.env.EVOLUTION_API_KEY ||= 'test';
  ({ parseCashPocketDeleteReference } = await import('../src/verticals/cash/pocket-context.js'));
});

describe('cash contexto de exclusão de cofrinho', () => {
  it.each([
    'apaga ele pfv',
    'exclui esse',
    'remove isso',
    'tira ele por favor'
  ])('reconhece referência curta depois de um cofrinho: %s', input => {
    expect(parseCashPocketDeleteReference(input)).toEqual({ kind: 'context' });
  });

  it.each([
    'apaga eles pfv',
    'exclui esses',
    'remove todos eles',
    'tira todas elas por favor'
  ])('reconhece referência plural aos cofrinhos recém mostrados: %s', input => {
    expect(parseCashPocketDeleteReference(input)).toEqual({ kind: 'context-all' });
  });

  it.each([
    'apaga o cofrinho Viagem',
    'exclui cofrinho Arles Cash',
    'remove o cofrinho Casa'
  ])('reconhece exclusão explícita de cofrinho: %s', input => {
    expect(parseCashPocketDeleteReference(input)).toEqual({ kind: 'explicit' });
  });

  it('não rouba uma exclusão financeira específica', () => {
    expect(parseCashPocketDeleteReference('apaga ele porque registrei o mercado errado')).toBeNull();
    expect(parseCashPocketDeleteReference('apaga o último lançamento')).toBeNull();
  });
});
