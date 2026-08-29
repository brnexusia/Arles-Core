import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

describe('Arles Cash contextual memory v2', () => {
  const source = fs.readFileSync('src/verticals/cash/ai-first-handler.ts', 'utf8');

  it('loads recent conversation before semantic routing', () => {
    expect(source).toContain('loadCashConversationMemory(context.company.id, context.message.phone, cashConversationMemorySize)');
    expect(source).toContain("conversationInput.push({ role: 'user', content: context.combinedText })");
  });

  it('tells the semantic layer to use prior messages only as context', () => {
    expect(source).toContain('A última mensagem user é o pedido atual; as anteriores servem como contexto');
    expect(source).toContain('Use o histórico para resolver referências');
  });

  it('never asks the math engine to infer the current balance', () => {
    expect(source).toContain('Use base_mode=current_balance SOMENTE quando a pessoa pedir explicitamente');
  });
});
