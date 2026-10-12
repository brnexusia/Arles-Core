import { randomUUID } from 'node:crypto';
import { redis } from '../infrastructure/redis.js';

function digits(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

function allSame(value: string): boolean {
  return /^([0-9])\1+$/.test(value);
}

function validCpf(value: string): boolean {
  if (!/^\d{11}$/.test(value) || allSame(value)) return false;
  const calc = (length: number) => {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(value[i]) * (length + 1 - i);
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return calc(9) === Number(value[9]) && calc(10) === Number(value[10]);
}

function validCnpj(value: string): boolean {
  if (!/^\d{14}$/.test(value) || allSame(value)) return false;
  const calc = (baseLength: number) => {
    const weights = baseLength === 12
      ? [5,4,3,2,9,8,7,6,5,4,3,2]
      : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const sum = weights.reduce((acc, weight, index) => acc + Number(value[index]) * weight, 0);
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  return calc(12) === Number(value[12]) && calc(13) === Number(value[13]);
}

export function validatedCpfCnpj(input: unknown): string {
  const document = digits(input);
  if (!(validCpf(document) || validCnpj(document))) throw new Error('CPF_CNPJ_INVALID');
  return document;
}

export async function withBeautyActivationGuard<T>(
  companyId: string,
  fn: () => Promise<T>
): Promise<T> {
  const lockKey = `arles:beauty:billing:activation-lock:${companyId}`;
  const cooldownKey = `arles:beauty:billing:activation-cooldown:${companyId}`;
  const token = randomUUID();

  if (await redis.get(cooldownKey)) throw new Error('ASAAS_ACTIVATION_COOLDOWN');
  const acquired = await redis.set(lockKey, token, 'PX', 45_000, 'NX');
  if (acquired !== 'OK') throw new Error('ASAAS_ACTIVATION_IN_PROGRESS');

  try {
    const result = await fn();
    await redis.set(cooldownKey, '1', 'EX', 120);
    return result;
  } finally {
    await redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
      1,
      lockKey,
      token
    ).catch(() => undefined);
  }
}
