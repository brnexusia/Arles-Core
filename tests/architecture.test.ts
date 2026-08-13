import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(path));
    else if (entry.name.endsWith('.ts')) output.push(path);
  }
  return output;
}

describe('dependency direction', () => {
  it('kernel e capabilities globais não importam Delivery', async () => {
    const roots = ['src/core', 'src/platform', 'src/infrastructure', 'src/media', 'src/whatsapp'];
    const violations: string[] = [];
    for (const root of roots) {
      for (const file of await filesBelow(root)) {
        const source = await readFile(file, 'utf8');
        if (/from\s+['"][^'"]*verticals\/delivery/i.test(source)) violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it('novas migrations são aditivas', async () => {
    const migration = await readFile('migrations/006_platform_globalization.sql', 'utf8');
    expect(migration).not.toMatch(/\b(drop|truncate)\b/i);
    expect(migration).toContain('company_capabilities');
    expect(migration).toContain('platform_jobs');
  });
});
