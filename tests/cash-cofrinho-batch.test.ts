import { beforeAll, describe, expect, it } from 'vitest';

let parseCashPocketCreateNames: (input: string) => string[];

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
  process.env.EVOLUTION_BASE_URL ||= 'http://127.0.0.1:8080';
  process.env.EVOLUTION_API_KEY ||= 'test';
  ({ parseCashPocketCreateNames } = await import('../src/verticals/cash/cofrinhos.js'));
});

describe('cash cofrinhos em lote', () => {
  it('separa exatamente os cinco cofrinhos do cenário real do WhatsApp', () => {
    expect(parseCashPocketCreateNames([
      'Cria o cofrinho chamado Sinapse',
      'E cria outro cofrinho chamado Arles Cash',
      'Outro chamado Arles Delivery',
      'Outro chamado Arles beauty',
      'E outro só arles'
    ].join('\n\n'))).toEqual([
      'Sinapse',
      'Arles Cash',
      'Arles Delivery',
      'Arles beauty',
      'arles'
    ]);
  });

  it('aceita lista por linha sem repetir a palavra cofrinho em todas as linhas', () => {
    expect(parseCashPocketCreateNames([
      'Crie os cofrinhos:',
      'Viagem',
      'Emergência',
      'Casa'
    ].join('\n'))).toEqual(['Viagem', 'Emergência', 'Casa']);
  });

  it('remove duplicados sem juntar comandos ao nome', () => {
    expect(parseCashPocketCreateNames('criar cofrinho Casa e outro chamado Casa e outro chamado Lazer'))
      .toEqual(['Casa', 'Lazer']);
  });
});
