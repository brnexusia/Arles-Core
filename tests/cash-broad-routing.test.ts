import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { routeCashInput } = await import('../src/verticals/cash/broad-routing.js');

function rewritten(input: string): string | null {
  const route = routeCashInput(input);
  return route?.kind === 'rewrite' ? route.text : null;
}

describe('cash broad routing', () => {
  it('entende resumos e balanços de períodos sem comando exato', () => {
    expect(rewritten('Resumo do dia')).toBe('quais foram meus registros hoje?');
    expect(rewritten('Como foi hoje?')).toBe('quais foram meus registros hoje?');
    expect(rewritten('Fechamento de ontem')).toBe('quais foram meus registros ontem?');
    expect(rewritten('Resumo da semana')).toBe('relatório semanal');
    expect(rewritten('Balanço mensal')).toBe('relatório mensal');
    expect(rewritten('Resumo')).toBe('quais foram meus registros hoje?');
    expect(rewritten('Lista de gastos')).toBe('quais foram meus registros hoje?');
  });

  it('entende saldo e visão financeira geral', () => {
    expect(rewritten('Quanto sobrou?')).toBe('saldo');
    expect(rewritten('Como estão minhas finanças?')).toBe('saldo');
    expect(rewritten('Qual minha situação financeira?')).toBe('saldo');
  });

  it('entende histórico em linguagem natural', () => {
    expect(rewritten('Minhas últimas movimentações')).toBe('histórico');
    expect(rewritten('O que registrei?')).toBe('histórico');
    expect(rewritten('Meus últimos lançamentos')).toBe('histórico');
  });

  it('normaliza consultas cotidianas', () => {
    expect(rewritten('Quanto saiu hoje?')).toContain('quanto gastei');
    expect(rewritten('Quanto entrou ontem?')).toContain('quanto recebi');
    expect(rewritten('O que saiu ontem?')).toContain('quais foram minhas despesas');
    expect(rewritten('O que entrou hoje?')).toContain('quais foram minhas receitas');
    expect(rewritten('Movimentações de ontem')).toBe('quais foram meus registros ontem?');
    expect(rewritten('Onde gastei mais?')).toBe('maior gasto hoje');
  });

  it('entende correções naturais sem abrir rotas destrutivas para conta', () => {
    expect(rewritten('Corrige isso')).toBe('edita o último');
    expect(rewritten('Na verdade foi 20 reais')).toBe('muda o último para 20 reais');
    expect(rewritten('Apaga isso')).toBe('apaga o último');
    expect(rewritten('Foi engano')).toBe('apaga o último');
    expect(routeCashInput('Apaga minha conta')).toBeNull();
  });

  it('cobre descoberta, cobrança, trial, categorias e agenda', () => {
    expect(rewritten('O que dá pra fazer aqui?')).toBe('ajuda');
    expect(rewritten('Como mexe nisso?')).toBe('ajuda');
    expect(routeCashInput('Quanto custa o Arles?')?.kind).toBe('plans');
    expect(routeCashInput('Quando acaba meu trial?')?.kind).toBe('trial');
    expect(routeCashInput('Quais categorias existem?')?.kind).toBe('categories');
    expect(routeCashInput('Quando recebo os relatórios?')?.kind).toBe('schedule');
  });
});
