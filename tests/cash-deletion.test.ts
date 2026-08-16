import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  isCashDeletionCancellation,
  isCashDeletionCommand,
  isCashDeletionConfirmation,
  parseCashBulkDeletionIntent
} = await import('../src/verticals/cash/deletion.js');

describe('cash deletion intent', () => {
  it('entende “apaga esses 4 registros” como exclusão da última lista', () => {
    expect(isCashDeletionCommand('Apaga esses 4 registros')).toBe(true);
    expect(parseCashBulkDeletionIntent('Apaga esses 4 registros')).toEqual({
      kind: 'last-list',
      count: 4
    });
  });

  it('entende exclusão total da conta financeira', () => {
    expect(parseCashBulkDeletionIntent('Apaga todos os meus registros')).toEqual({ kind: 'all' });
    expect(parseCashBulkDeletionIntent('Remove todos os registros')).toEqual({ kind: 'all' });
  });

  it('não confunde exclusão pontual com lote', () => {
    expect(isCashDeletionCommand('apaga o registro 2')).toBe(true);
    expect(parseCashBulkDeletionIntent('apaga o registro 2')).toBeNull();
  });

  it('nunca trata um gasto de quatro reais como exclusão', () => {
    expect(isCashDeletionCommand('gastei 4 reais no mercado')).toBe(false);
    expect(parseCashBulkDeletionIntent('gastei 4 reais no mercado')).toBeNull();
  });

  it('não intercepta pergunta de ajuda sobre exclusão', () => {
    expect(isCashDeletionCommand('como eu apago meus registros?')).toBe(false);
  });

  it('reconhece sim e não da confirmação de exclusão', () => {
    expect(isCashDeletionConfirmation('sim')).toBe(true);
    expect(isCashDeletionConfirmation('pode apagar')).toBe(true);
    expect(isCashDeletionCancellation('não')).toBe(true);
    expect(isCashDeletionCancellation('cancela')).toBe(true);
  });
});
