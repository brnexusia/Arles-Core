import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  deterministicCashParse,
  isStrongDeterministicCashTransaction,
  categoryFrom,
  descriptionFrom
} = await import('../src/verticals/cash/parser.js');

describe('cash parser', () => {
  it('registra despesa simples no mercado', () => {
    const result = deterministicCashParse('Gastei 15 no mercado hoje');
    expect(result).toMatchObject({
      type: 'expense',
      amount: 15,
      category: 'Alimentação',
      merchant: 'mercado',
      description: 'mercado'
    });
  });

  it('entende valor brasileiro e receita', () => {
    const result = deterministicCashParse('Recebi R$ 1.250,90 do cliente João');
    expect(result).toMatchObject({
      type: 'income',
      amount: 1250.9,
      category: 'Receita'
    });
  });

  it('aceita despesas curtas sem verbo', () => {
    expect(deterministicCashParse('farmácia 45')).toMatchObject({ type: 'expense', amount: 45, category: 'Saúde' });
    expect(deterministicCashParse('120 no almoço')).toMatchObject({ type: 'expense', amount: 120, category: 'Alimentação' });
  });

  it('aceita inteiro, vírgula e ponto decimal', () => {
    expect(deterministicCashParse('mercado 4')?.amount).toBe(4);
    expect(deterministicCashParse('mercado 4,50')?.amount).toBe(4.5);
    expect(deterministicCashParse('mercado 4.50')?.amount).toBe(4.5);
  });

  it('usa as categorias domésticas fechadas', () => {
    expect(categoryFrom('gasolina', 'expense')).toBe('Transporte');
    expect(categoryFrom('plano de saúde', 'expense')).toBe('Saúde');
    expect(categoryFrom('condomínio', 'expense')).toBe('Moradia');
    expect(categoryFrom('faculdade', 'expense')).toBe('Educação');
    expect(categoryFrom('academia', 'expense')).toBe('Pessoal');
    expect(categoryFrom('blusinha na SHEIN', 'expense')).toBe('Pessoal');
    expect(categoryFrom('guardei dinheiro', 'expense')).toBe('Reserva');
    expect(categoryFrom('qualquer entrada', 'income')).toBe('Receita');
    expect(categoryFrom('coisa diferente', 'expense')).toBe('Outros');
  });

  it('gera descrição curta e útil para o registro', () => {
    const result = deterministicCashParse('comprei uma blusinha na SHEIN de 15 reais');
    expect(result).toMatchObject({
      type: 'expense',
      amount: 15,
      category: 'Pessoal',
      merchant: 'SHEIN',
      description: 'blusinha na SHEIN'
    });
    expect(descriptionFrom('Gastei 85,56 no mercado agora')).toBe('mercado');
  });

  it('preserva os itens citados em uma compra', () => {
    const description = descriptionFrom('Gastei 80 em pão, leite, café e frutas hoje');
    expect(description).toContain('pão');
    expect(description).toContain('leite');
    expect(description).toContain('café');
    expect(description).toContain('frutas');
    expect(description.toLowerCase()).not.toContain('itens diversos');
  });

  it('não inventa lançamento sem valor', () => {
    expect(deterministicCashParse('Fui ao mercado hoje')).toBeNull();
    expect(deterministicCashParse('Gastei no mercado dia 15')).toBeNull();
  });

  it('mantém lançamentos muito diretos em script sem precisar de IA', () => {
    expect(isStrongDeterministicCashTransaction('gastei 50 no mercado')).toBe(true);
    expect(isStrongDeterministicCashTransaction('recebi 2000 de salário')).toBe(true);
    expect(isStrongDeterministicCashTransaction('farmácia 45')).toBe(true);
    expect(isStrongDeterministicCashTransaction('guardei 300')).toBe(true);
  });

  it('manda para a IA quando sai do padrão simples', () => {
    expect(isStrongDeterministicCashTransaction('fiz umas compras diferentes e acabou saindo 80')).toBe(false);
    expect(isStrongDeterministicCashTransaction('recebi 600 e depois guardei 300')).toBe(false);
    expect(isStrongDeterministicCashTransaction('paguei 100 nisso e ela depois me devolveu 20')).toBe(false);
  });
});
