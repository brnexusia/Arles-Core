const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

function localShadow(date = new Date()): Date {
  return new Date(date.getTime() - BRT_OFFSET_MS);
}

export function brazilParts(date = new Date()) {
  const local = localShadow(date);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
    weekday: local.getUTCDay()
  };
}

export function brazilDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour + 3, minute, 0, 0));
}

export function isoBrazil(date = new Date()): string {
  const p = brazilParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Formata uma data para DD/MM/AAAA sem carregar hora, timezone ou localização.
 * O pg pode devolver uma coluna DATE como string YYYY-MM-DD ou como um Date
 * serializado (ex.: "Sat Aug 15 2026 00:00:00 GMT+0000 ...").
 */
export function formatBrazilDate(value: string | Date): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getUTCDate()).padStart(2, '0')}/${String(value.getUTCMonth() + 1).padStart(2, '0')}/${value.getUTCFullYear()}`;
  }

  const raw = String(value ?? '').trim();
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:\b|T)/);
  if (isoMatch) return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return `${String(parsed.getUTCDate()).padStart(2, '0')}/${String(parsed.getUTCMonth() + 1).padStart(2, '0')}/${parsed.getUTCFullYear()}`;
  }

  return raw;
}

export function addBrazilDays(date: Date, days: number): Date {
  const p = brazilParts(date);
  const shadow = new Date(Date.UTC(p.year, p.month - 1, p.day + days, p.hour, p.minute, p.second));
  return brazilDate(
    shadow.getUTCFullYear(),
    shadow.getUTCMonth() + 1,
    shadow.getUTCDate(),
    shadow.getUTCHours(),
    shadow.getUTCMinutes()
  );
}

export function dateIsoOffset(days: number, from = new Date()): string {
  return isoBrazil(addBrazilDays(from, days));
}

export function currentWeekWindow(now = new Date()) {
  const p = brazilParts(now);
  const daysSinceMonday = p.weekday === 0 ? 6 : p.weekday - 1;
  return {
    from: dateIsoOffset(-daysSinceMonday, now),
    to: isoBrazil(now)
  };
}

export function previousWeekWindow(now = new Date()) {
  const p = brazilParts(now);
  const daysSinceMonday = p.weekday === 0 ? 6 : p.weekday - 1;
  return {
    from: dateIsoOffset(-(daysSinceMonday + 7), now),
    to: dateIsoOffset(-(daysSinceMonday + 1), now)
  };
}

export function currentMonthWindow(now = new Date()) {
  const p = brazilParts(now);
  return {
    from: `${p.year}-${String(p.month).padStart(2, '0')}-01`,
    to: isoBrazil(now)
  };
}

export function previousMonthWindow(now = new Date()) {
  const p = brazilParts(now);
  const firstCurrent = new Date(Date.UTC(p.year, p.month - 1, 1));
  const previousEnd = new Date(firstCurrent.getTime() - 86_400_000);
  const previousYear = previousEnd.getUTCFullYear();
  const previousMonth = previousEnd.getUTCMonth() + 1;
  const previousDay = previousEnd.getUTCDate();
  return {
    from: `${previousYear}-${String(previousMonth).padStart(2, '0')}-01`,
    to: `${previousYear}-${String(previousMonth).padStart(2, '0')}-${String(previousDay).padStart(2, '0')}`
  };
}

export function monthBeforeWindow(fromIso: string) {
  const [year, month] = fromIso.split('-').map(Number);
  const previousEnd = new Date(Date.UTC(year!, month! - 1, 0));
  const py = previousEnd.getUTCFullYear();
  const pm = previousEnd.getUTCMonth() + 1;
  const pd = previousEnd.getUTCDate();
  return {
    from: `${py}-${String(pm).padStart(2, '0')}-01`,
    to: `${py}-${String(pm).padStart(2, '0')}-${String(pd).padStart(2, '0')}`
  };
}

export function nextMondayAt8Brazil(from = new Date()): Date {
  const p = brazilParts(from);
  let days = (8 - p.weekday) % 7;
  if (days === 0 && (p.hour > 8 || (p.hour === 8 && p.minute >= 0))) days = 7;
  const target = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return brazilDate(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), 8, 0);
}

export function nextFirstOfMonthAt8Brazil(from = new Date()): Date {
  const p = brazilParts(from);

  // Se ainda for antes das 08:00 do próprio dia 1, agenda para hoje.
  if (p.day === 1 && p.hour < 8) {
    return brazilDate(p.year, p.month, 1, 8, 0);
  }

  const target = new Date(Date.UTC(p.year, p.month, 1));
  return brazilDate(target.getUTCFullYear(), target.getUTCMonth() + 1, 1, 8, 0);
}
