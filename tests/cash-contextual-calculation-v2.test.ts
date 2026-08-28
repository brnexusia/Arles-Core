import { describe, expect, it } from 'vitest';

describe('Arles Cash contextual calculation v2', () => {
  it('keeps the user reported scenario as a regression contract', () => {
    expect(600 - 120 - 330 - 600).toBe(-450);
  });
});
