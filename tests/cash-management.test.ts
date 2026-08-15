import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.EVOLUTION_BASE_URL ||= 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY ||= 'test-key';

const {
  asksHowToManage,
  deletionTarget,
  editTarget,
  normalizeCashText,
  parseCashEditPatch
} = await import('../src/verticals/cash/management.js');

describe('cash record management', () => {
  it('entende remoção natural do registro recente', () => {
    expect(deletionTarget('Retira o registro de agora')).toEqual({ kind: 'last' });
    expect(deletionTarget('errei')).toEqual({ kind: 'last' });
    expect(deletionTarget('apaga o 2')).toEqual({ kind: 'index', index: 2 });
  });

  it('não apaga quando o usuário está perguntando como fazer', () => {
    expect(asksHowToManage('Como posso remover ou editar?')).toBe(true);
    expect(deletionTarget('Como posso remover o último?')).toBeNull();
    expect(editTarget('Como posso editar o registro?')).toBeNull();
  });

  it('normaliza perguntas naturais pelos comandos para o menu de ajuda', () => {
    expect(normalizeCashText('Quais os comandos?')).toBe('comandos');
    expect(normalizeCashText('Quais são os comandos?')).toBe('comandos');
    expect(normalizeCashText('Que comandos existem?')).toBe('comandos');
  });

  it('entende alvo de edição por último ou posição do histórico', () => {
    expect(editTarget('edita o último')).toEqual({ kind: 'last' });
    expect(editTarget('edita o 3')).toEqual({ kind: 'index', index: 3 });
  });

  it('extrai mudanças de valor, categoria, descrição e data', () => {
    expect(parseCashEditPatch('muda o último para 18 reais')).toMatchObject({ amount: 18 });
    expect(parseCashEditPatch('troca a categoria do último para Pessoal')).toMatchObject({ category: 'Pessoal' });
    expect(parseCashEditPatch('descrição: blusinha na SHEIN')).toMatchObject({ description: 'blusinha na SHEIN' });
    expect(parseCashEditPatch('o valor foi 18 e foi ontem')).toMatchObject({ amount: 18 });
    expect(parseCashEditPatch('o valor foi 4,50')).toMatchObject({ amount: 4.5 });
  });
});
