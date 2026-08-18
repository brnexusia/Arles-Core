export function normalizeCashPocketLanguage(value: string): string {
  return String(value ?? '')
    .replace(/\bcofres\b/gi, 'cofrinhos')
    .replace(/\bcofre\b/gi, 'cofrinho')
    .replace(/\bconfrinhos\b/gi, 'cofrinhos')
    .replace(/\bconfrinho\b/gi, 'cofrinho')
    .replace(/\bcofrinos\b/gi, 'cofrinhos')
    .replace(/\bcofrino\b/gi, 'cofrinho')
    .replace(/\bconfrinos\b/gi, 'cofrinhos')
    .replace(/\bconfrino\b/gi, 'cofrinho')
    .replace(/\bcaixinhas\b/gi, 'cofrinhos')
    .replace(/\bcaixinha\b/gi, 'cofrinho')
    .replace(/\benvelopes\b/gi, 'cofrinhos')
    .replace(/\benvelope\b/gi, 'cofrinho')
    .replace(/\bpotinhos\b/gi, 'cofrinhos')
    .replace(/\bpotinho\b/gi, 'cofrinho')
    .replace(/\bporquinhos\b/gi, 'cofrinhos')
    .replace(/\bporquinho\b/gi, 'cofrinho');
}
