import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyCashCorpus, isCashMixedFinancialNarrative } from '../src/verticals/cash/conversation-corpus.js';

const EXACT_LONG_MESSAGE = `Ontem paguei a fatura do cartão de crédito no valor de R$ 1.850,00 referente às compras do mês passado, e logo depois recebi meu salário de R$ 7.500,00 na conta corrente. Aproveitei para deixar agendado o pagamento do aluguel de R$ 1.600,00 que vence amanhã, além da conta de luz de R$ 220,00 e a de internet de R$ 110,00. Na semana passada fiz uma compra de supermercado no valor de R$ 450,00 e abasteci o carro por R$ 250,00. Para o lazer do fim de semana passado, gastei R$ 180,00 em um jantar fora e R$ 90,00 em aplicativos de transporte.
Pensando nos próximos dias, tenho uma projeção de receber R$ 1.200,00 de um freela que termino na quinta-feira, mas também precisarei desembolsar R$ 350,00 para a manutenção preventiva do carro na sexta. Se eu decidir viajar no feriado do mês que vem, estimo que gastarei cerca de R$ 900,00 com hospedagem e R$ 400,00 com combustível, o que elevará bastante minhas despesas daquele período. Por outro lado, se eu optar por ficar em casa, imagino que meus gastos extras com lazer não passem de R$ 200,00 no total.
Nos lançamentos futuros já fixos, tenho a parcela do meu notebook novo no valor de R$ 320,00 caindo todo dia 10, além da assinatura da academia por R$ 110,00 e o streaming de vídeo por R$ 55,00 mensais. Estimando minhas compras de mercado para o restante do mês, prevejo gastar mais uns R$ 600,00 divididos em duas idas ao hipermercado. Caso eu decida fechar aquele novo cliente de consultoria, minha receita fixa mensal aumentará em R$ 1.500,00 a partir do próximo mês, o que me daria uma folga considerável no orçamento.
Ainda como estimativa de consumo, calculo que gaste em média R$ 150,00 por semana com farmácia e pequenos utilitários, totalizando cerca de R$ 600,00 mensais nessa categoria. Recebi a notícia de que o condomínio do prédio terá um reajuste de 5% no mês que vem, então minha despesa com isso passará dos atuais R$ 400,00 para R$ 420,00. Se eu conseguir vender minha bicicleta antiga por R$ 800,00, pretendo usar esse valor exclusivamente para amortizar a fatura do cartão de crédito.
Fazendo uma projeção anual, estimo que meu IPTU venha em torno de R$ 1.200,00 à vista no início do ano que vem, ou dividido em parcelas de R$ 105,00. Caso eu faça aquela pós-graduação online, terei um custo fixo adicional de R$ 380,00 mensais pelos próximos 18 meses, o que exigirá uma reestruturação nos meus investimentos. Para compensar, estimo que se eu cortar os pedidos de delivery dos fins de semana, economizarei pelo menos R$ 400,00 por mês, valor que pretendo direcionar diretamente para a minha reserva de emergência.
Nos registros recentes, gastei R$ 75,00 em uma consulta médica de rotina e R$ 120,00 na compra de ração para o cachorro. Para o aniversário do meu irmão no próximo sábado, já reservei R$ 150,00 para o presente coletivo e estimo gastar mais R$ 100,00 na comemoração. Se o dólar continuar oscilando, estimo que minha próxima compra de insumos importados para o trabalho suba de R$ 500,00 para R$ 580,00.
Em termos de rendimentos passivos, meus investimentos em renda fixa vêm rendendo uma média líquida de R$ 350,00 por mês, dinheiro que costumo reinvestir automaticamente. No entanto, se eu precisar resgatar R$ 2.000,00 da aplicação para trocar os pneus do carro mês que vem, deixarei de render cerca de R$ 20,00 mensais sobre esse montante. Por fim, estimo que se mantiver meu padrão de vida atual e evitar compras por impulso, fecharei o semestre com uma sobra acumulada de aproximadamente R$ 4.500,00 livres na conta poupança.`;

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

  it('recognizes the exact WhatsApp regression message as a mixed batch', () => {
    expect(isCashMixedFinancialNarrative(EXACT_LONG_MESSAGE)).toBe(true);
    expect(classifyCashCorpus(EXACT_LONG_MESSAGE).intent).toBe('batch_transaction');
  });

  it('production access delegates financial language to the AI-first router', () => {
    const access = readFileSync(join(process.cwd(), 'src/verticals/cash/access-handler.ts'), 'utf8');
    expect(access).toContain('const aiResult = await cashAiFirstHandler.handle(context)');
    expect(access).not.toContain('await handleCashMixedNarrativeGate(context)');
    expect(access).not.toContain('await handleCashScheduleDeterministic(context)');
  });

  it('keeps a simple recurring future bill as schedule', () => {
    expect(classifyCashCorpus('todo dia 10 pago R$ 100 do cartão').intent).toBe('schedule');
  });
  it('keeps a simple hypothetical calculation as projection', () => {
    expect(classifyCashCorpus('se eu gastar R$ 100, quanto sobra?').intent).toBe('projection');
  });
  it('does not call a short factual batch a mixed narrative', () => {
    expect(isCashMixedFinancialNarrative('paguei R$ 80 no mercado e recebi R$ 200 de um freela')).toBe(false);
  });
});
