import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  cashQuotedDeleteIntent,
  cashQuotedEditIntent,
  cashQuotedEditPatch,
  cashQuotedSelectionIndex
} = await import('../src/verticals/cash/quoted-management.js');

describe('cash quoted management', () => {
  it('entende edição natural quando a própria citação define o alvo', () => {
    expect(cashQuotedEditIntent('corrige essa para 80')).toBe(true);
    expect(cashQuotedEditPatch('corrige essa para 80')).toMatchObject({ amount: 80 });
  });

  it('entende mudança de tipo em mensagem citada', () => {
    expect(cashQuotedEditPatch('essa foi entrada')).toMatchObject({
      type: 'income',
      category: 'Receita'
    });
    expect(cashQuotedEditPatch('isso era despesa')).toMatchObject({
      type: 'expense'
    });
  });

  it('entende exclusão da mensagem citada sem confundir com pergunta de ajuda', () => {
    expect(cashQuotedDeleteIntent('apaga essa')).toBe(true);
    expect(cashQuotedDeleteIntent('como posso apagar essa?')).toBe(false);
  });

  it('exige item quando a mensagem citada gerou vários lançamentos', () => {
    expect(cashQuotedSelectionIndex('corrige essa', 3)).toBeNull();
    expect(cashQuotedSelectionIndex('editar item 2', 3)).toBe(1);
    expect(cashQuotedSelectionIndex('apaga registro 3', 3)).toBe(2);
    expect(cashQuotedSelectionIndex('apaga essa', 1)).toBe(0);
  });
});
