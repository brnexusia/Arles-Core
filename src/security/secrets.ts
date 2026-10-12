import { timingSafeEqual } from 'node:crypto';

function safeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function matchesAnySecret(candidateInput: unknown, secrets: Array<string | undefined | null>): boolean {
  const candidate = String(candidateInput ?? '').trim();
  if (!candidate) return false;
  return secrets.some(secret => safeEqual(candidate, String(secret ?? '').trim()));
}

export function internalSecrets(): string[] {
  return [process.env.INTERNAL_API_KEY, process.env.INTERNAL_API_KEY_PREVIOUS]
    .map(value => String(value ?? '').trim())
    .filter(Boolean);
}

export function asaasWebhookSecrets(): string[] {
  return [process.env.ASAAS_WEBHOOK_TOKEN, process.env.ASAAS_WEBHOOK_TOKEN_PREVIOUS]
    .map(value => String(value ?? '').trim())
    .filter(Boolean);
}
