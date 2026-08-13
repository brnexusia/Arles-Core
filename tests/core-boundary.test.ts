import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const protectedFiles = [
  'src/server.ts',
  'src/core/engine.ts',
  'src/auth/auth.service.ts',
  'src/billing/billing.service.ts'
];

describe('core boundary', () => {
  it.each(protectedFiles)('%s does not import Delivery implementation', file => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"][^'"]*verticals\/delivery/);
  });
});
