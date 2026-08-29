import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

describe('Arles Cash contextual calculation contract v2', () => {
  const source = fs.readFileSync('src/verticals/cash/ai-first-handler.ts', 'utf8');

  it('gives GPT-5 Nano a structured calculation intent', () => {
    expect(source).toContain("'calculation'");
    expect(source).toContain("base_mode: z.enum(['zero', 'current_balance', 'explicit'])");
    expect(source).toContain("type: z.enum(['income', 'expense'])");
  });

  it('defines zero balance as the default for listed-value arithmetic', () => {
    expect(source).toContain('Use base_mode=zero quando a pessoa quer apenas a conta dos valores que listou');
    expect(source).toContain('NÃO inclua o saldo atual implicitamente');
  });

  it('does not turn future wording alone into a saved forecast', () => {
    expect(source).toContain('Datas e verbos no futuro, sozinhos, NÃO significam agendamento');
    expect(source).toContain('NÃO é forecast_schedule só porque fala do futuro');
  });
});
