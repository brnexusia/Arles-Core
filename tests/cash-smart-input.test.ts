import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  adjustCashRemainder,
  isCashCasualAcknowledgement,
  isCashExpenseListRequest,
  looksLikeCashBatch
} = await import('../src/verticals/cash/smart-input.js');
const { deterministicCashParse } = await import('../src/verticals/cash/parser.js');
const { normalizeEvolutionMessage } = await import('../src/whatsapp/normalize.js');

describe('cash smart input', () => {
  it('não transforma confirmação casual em erro ou guia', () => {
    expect(isCashCasualAcknowledgement('Certo')).toBe(true);
    expect(isCashCasualAcknowledgement('Entendi!')).toBe(true);
    expect(isCashCasualAcknowledgement('Beleza')).toBe(true);
  });

  it('entende pedido natural de lista de gastos', () => {
    expect(isCashExpenseListRequest('Tem como fazer uma lista organizada do que eu gastei?')).toBe(true);
    expect(isCashExpenseListRequest('Eu já citei acima com o que foi os meus gastos')).toBe(true);
  });

  it('detecta mensagem com vários movimentos antes da rota de consulta', () => {
    const message = [
      'Eu ganhei hoje 600,00',
      'Eu guardei 300,00',
      '100,00 paguei unhas',
      '100,00 paguei uma parcela da bicicleta',
      'E com os outros 100,00 eu comprei uns itens e me sobrou 20,00'
    ].join('\n');
    expect(looksLikeCashBatch(message)).toBe(true);
  });

  it('trata dinheiro guardado como Reserva', () => {
    expect(deterministicCashParse('Guardei 300 reais hoje')).toMatchObject({
      type: 'expense',
      amount: 300,
      category: 'Reserva'
    });
  });

  it('desconta sobra explicitamente informada do valor destinado ao gasto', () => {
    const adjusted = adjustCashRemainder(
      'Com os outros 100,00 comprei itens e sobrou 20,00',
      {
        type: 'expense',
        amount: 100,
        category: 'Outros',
        merchant: '',
        description: 'itens',
        transactionDate: '2026-08-15'
      }
    );
    expect(adjusted.amount).toBe(80);
  });

  it('preserva o texto da mensagem citada no WhatsApp', () => {
    const message = normalizeEvolutionMessage({
      event: 'messages.upsert',
      instance: 'cash',
      data: {
        key: { id: 'msg-2', remoteJid: '5575999999999@s.whatsapp.net', fromMe: false },
        message: {
          extendedTextMessage: {
            text: 'Eu já citei acima com o que foi os meus gastos',
            contextInfo: {
              quotedMessage: {
                conversation: 'Eu ganhei 600 e paguei 100 nas unhas'
              }
            }
          }
        }
      }
    });

    expect(message.text).toBe('Eu já citei acima com o que foi os meus gastos');
    expect(message.quotedText).toBe('Eu ganhei 600 e paguei 100 nas unhas');
  });
});
