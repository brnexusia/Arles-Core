export interface CashSilenceWindowInput {
  lastActivityAt: number;
  now: number;
  silenceMs: number;
  typing: boolean;
}

/**
 * Regra conversacional do Cash:
 * - qualquer mensagem/presença reinicia a janela curta;
 * - enquanto o usuário estiver digitando/gravando, a janela fica congelada;
 * - assim que ele para, usamos a janela configurada (250ms por padrão, teto 500ms)
 *   para agrupar o último fragmento sem adicionar segundos artificiais à resposta.
 */
export function cashSilenceRemainingMs(input: CashSilenceWindowInput): number {
  const silenceMs = Math.max(0, Number(input.silenceMs) || 0);
  if (silenceMs <= 0) return 0;
  if (input.typing) return silenceMs;

  const lastActivityAt = Number(input.lastActivityAt) || 0;
  const now = Number(input.now) || 0;
  if (lastActivityAt <= 0 || now <= 0) return silenceMs;

  const elapsed = Math.max(0, now - lastActivityAt);
  return Math.max(0, silenceMs - elapsed);
}
