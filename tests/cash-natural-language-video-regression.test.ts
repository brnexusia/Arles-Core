import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { cashHelpSection } = await import('../src/verticals/cash/help.js');
const { deletionTarget } = await import('../src/verticals/cash/management.js');
const { parseCashBulkDeletionIntent } = await import('../src/verticals/cash/deletion.js');
const { parseCashPocketDeleteReference } = await import('../src/verticals/cash/pocket-context.js');

describe('cash natural language regressions do fluxo real de WhatsApp', () => {
  it('comandos curtos executáveis não viram menu de ajuda', () => {
    expect(cashHelpSection('histórico')).toBeNull();
    expect(cashHelpSection('saldo')).toBeNull();
    expect(cashHelpSection('planos')).toBeNull();
    expect(cashHelpSection('meus cofrinhos')).toBeNull();
    expect(cashHelpSection('como consulto meu histórico?')).toBe('query');
  });

  it('“apaga o 2” aponta para o item 2 e não para desfazer exclusão', () => {
    expect(deletionTarget('apaga o 2')).toEqual({ kind: 'index', index: 2 });
    expect(deletionTarget('exclui o registro 2')).toEqual({ kind: 'index', index: 2 });
  });

  it('entende exclusão de todos os lançamentos em linguagem natural', () => {
    expect(parseCashBulkDeletionIntent('Quero que você apague todos os lançamentos que fiz anteriormente'))
      .toEqual({ kind: 'all' });
    expect(parseCashBulkDeletionIntent('Exclua todos os meus registros anteriores'))
      .toEqual({ kind: 'all' });
  });

  it('reconhece exclusão explícita de cofrinho antes de qualquer ajuda genérica', () => {
    expect(parseCashPocketDeleteReference('Quero que exclua o cofrinho Sonho'))
      .toEqual({ kind: 'explicit' });
    expect(parseCashPocketDeleteReference('Exclua o cofrinho Poupex e o cofrinho Sonho'))
      .toEqual({ kind: 'explicit' });
  });
});
