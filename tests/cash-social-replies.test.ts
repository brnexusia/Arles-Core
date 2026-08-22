import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const { cashSocialReply } = await import('../src/verticals/cash/ai-first-handler.js');
const { cashHelpMessage } = await import('../src/verticals/cash/help.js');

describe('cash social replies', () => {
  it('responde saudação como saudação, não como confirmação', () => {
    expect(cashSocialReply('greeting')).toBe('Oi! 😊 Como posso te ajudar?');
    expect(cashSocialReply('greeting')).not.toContain('Pode continuar falando comigo');
  });

  it('mantém respostas sociais curtas e naturais', () => {
    expect(cashSocialReply('thanks')).toBe('Por nada! 😊');
    expect(cashSocialReply('farewell')).toBe('Até mais! 👋');
    expect(cashSocialReply('wellbeing')).toBe('Tudo certo por aqui 😊 E com você?');
    expect(cashSocialReply('ack')).toBe('Certo 👍');
  });

  it('não ensina mais que lançamento exige confirmação', () => {
    const registerHelp = cashHelpMessage('register');
    expect(registerHelp).toContain('registro automaticamente');
    expect(registerHelp.toLowerCase()).not.toContain('peço sua confirmação');
    expect(registerHelp.toLowerCase()).not.toContain('pede sua confirmação');
  });
});
