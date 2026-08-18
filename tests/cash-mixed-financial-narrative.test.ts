import { describe, expect, it } from 'vitest';
import {
  classifyCashCorpus,
  isCashMixedFinancialNarrative
} from '../src/verticals/cash/conversation-corpus.js';

describe('Cash mixed financial narratives', () => {
  it('routes long facts + forecasts + hypotheses to batch before schedule/projection', () => {
    const input = [
      'Ontem paguei a fatura do cartão de crédito no valor de R$ 1.850,00 e logo depois recebi meu salário de R$ 7.500,00 na conta corrente.',
      'Também deixei agendado o aluguel de R$ 1.600,00 que vence amanhã, além da conta de luz de R$ 220,00 e internet de R$ 110,00.',
      'Na semana passada gastei R$ 450,00 no supermercado e R$ 250,00 abastecendo o carro.',
      'Se eu decidir viajar no mês que vem, estimo gastar R$ 900,00 com hospedagem e R$ 400,00 com combustível.',
      'Todo dia 10 tenho uma parcela de R$ 320,00 do notebook.',
      'Se eu mantiver meu padrão atual, estimo fechar o semestre com R$ 4.500,00 de sobra.'
    ].join(' ');

    expect(isCashMixedFinancialNarrative(input)).toBe(true);
    expect(classifyCashCorpus(input).intent).toBe('batch_transaction');
  });

  it('keeps a simple recurring future bill as schedule', () => {
    expect(classifyCashCorpus('todo dia 10 pago R$ 100 do cartão').intent).toBe('schedule');
  });

  it('keeps a simple hypothetical calculation as projection', () => {
    expect(classifyCashCorpus('se eu gastar R$ 100, quanto sobra?').intent).toBe('projection');
  });

  it('does not call a short factual batch a mixed narrative', () => {
    const input = 'paguei R$ 80 no mercado e recebi R$ 200 de um freela';
    expect(isCashMixedFinancialNarrative(input)).toBe(false);
  });
});
