import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

async function source(path: string): Promise<string> {
  return await readFile(path, 'utf8');
}

describe('Cash GPT-5 Nano first architecture', () => {
  it('não permite interceptador de pending antes do handler principal', async () => {
    const moduleSource = await source('src/verticals/cash/module.ts');
    expect(moduleSource).not.toContain('handlePendingInteraction:');
    expect(moduleSource).not.toContain('SHORT_PENDING_REPLIES');
    expect(moduleSource).not.toContain('isShortPendingReply');
  });

  it('chama o interpretador antes de qualquer decisão de onboarding ou execução', async () => {
    const access = await source('src/verticals/cash/access-handler.ts');
    const interpretIndex = access.indexOf('cashAiFirstHandler.interpret(context');
    const firstOnboardingBranch = access.indexOf("if (effectiveOnboardingState === 'welcome')");
    const executionIndex = access.indexOf('cashAiFirstHandler.execute(context, semantic)');

    expect(interpretIndex).toBeGreaterThan(-1);
    expect(firstOnboardingBranch).toBeGreaterThan(interpretIndex);
    expect(executionIndex).toBeGreaterThan(interpretIndex);

    // Antigos classificadores sobre a mensagem crua não podem voltar para o access layer.
    expect(access).not.toContain('handleCashDeterministicLanguage');
    expect(access).not.toContain('isCashDeletionCommand');
    expect(access).not.toContain('fastCashFaq');
    expect(access).not.toContain('normalizeCashPocketLanguage');
    expect(access).not.toContain('handleCashConversationSafety');
  });

  it('fixa o primeiro modelo em GPT-5 Nano e envia conversa + estado financeiro real', async () => {
    const aiFirst = await source('src/verticals/cash/ai-first-handler.ts');
    expect(aiFirst).toContain("CASH_FIRST_INTERPRETER_MODEL = 'gpt-5-nano'");
    expect(aiFirst).toContain('model: CASH_FIRST_INTERPRETER_MODEL');
    expect(aiFirst).toContain('loadCashConversationMemory');
    expect(aiFirst).toContain('cashService.listTransactions');
    expect(aiFirst).toContain('cashLedgerService.snapshot');
    expect(aiFirst).toContain('cashLedgerService.availability');
  });

  it('não deixa regex ou quote management vetarem a intenção decidida pelo Nano', async () => {
    const aiFirst = await source('src/verticals/cash/ai-first-handler.ts');
    expect(aiFirst).not.toContain('isCashProtectedNonTransaction');
    expect(aiFirst).not.toContain('handleCashQuotedManagement');
    expect(aiFirst).not.toMatch(/if\s*\([^)]*quoted(?:MessageId|Text)[^)]*\)[\s\S]{0,200}return/);
  });

  it('trata referência contextual como intenção estruturada de calculation e falha fechado', async () => {
    const aiFirst = await source('src/verticals/cash/ai-first-handler.ts');
    const access = await source('src/verticals/cash/access-handler.ts');

    expect(aiFirst).toContain("'calculation'");
    expect(aiFirst).toContain('executeCashContextualCalculation');
    expect(aiFirst).toContain('Não transforme isso em balance global');
    expect(access).toContain('if (!semantic) return cashAiInterpretationFailure();');
    expect(access).not.toContain('cashConversationHandler.handle(context)');
  });
});
