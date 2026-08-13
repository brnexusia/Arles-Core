import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearVerticalRegistryForTests,
  getVerticalModule,
  listVerticalModules,
  registerVertical
} from '../src/verticals/router.js';
import type { VerticalModule } from '../src/verticals/vertical.js';

describe('vertical registry', () => {
  beforeEach(() => clearVerticalRegistryForTests());

  it('registers a vertical without changing the engine', () => {
    const module: VerticalModule = {
      id: 'sandbox',
      name: 'Sandbox',
      version: '1.0.0',
      capabilities: ['sandbox.messages'],
      async handle() {
        return { actions: [{ type: 'text', text: 'ok' }] };
      }
    };

    registerVertical(module);

    expect(getVerticalModule('sandbox')).toBe(module);
    expect(listVerticalModules()).toEqual([module]);
  });

  it('rejects duplicate identifiers', () => {
    const module: VerticalModule = {
      id: 'sandbox',
      name: 'Sandbox',
      version: '1.0.0',
      capabilities: [],
      async handle() {
        return null;
      }
    };

    registerVertical(module);
    expect(() => registerVertical(module)).toThrow('Vertical duplicada');
  });
});
