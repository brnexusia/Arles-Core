import { describe, expect, it } from 'vitest';
import { cleanMenuResult, mergeMenuResults } from '../src/menu/menu-analysis.service.js';

describe('menu analysis normalization', () => {
  it('usa o menor valor de variação como preço base quando necessário', () => {
    const result = cleanMenuResult({
      categories: [{
        name: 'Pizzas',
        products: [{
          name: 'Calabresa',
          description: 'Calabresa e cebola',
          price: null,
          available: true,
          variations: [
            { name: 'M', price: 25 },
            { name: 'G', price: 30 },
            { name: 'GG', price: 40 }
          ]
        }]
      }]
    });

    expect(result.categories[0]?.products[0]?.price).toBe(25);
    expect(result.categories[0]?.products[0]?.variations).toHaveLength(3);
  });

  it('deduplica produtos e mantém variações recuperadas na auditoria', () => {
    const merged = mergeMenuResults(
      { categories: [{ name: 'Pizzas', products: [{ name: 'Baiana', description: '', price: 25, available: true, variations: [] }] }] },
      { categories: [{ name: 'Pizzas', products: [{ name: 'Baiana', description: 'Calabresa, cebola e pimenta', price: 25, available: true, variations: [{ name: 'G', price: 30 }] }] }] }
    );

    const product = merged.categories[0]?.products[0];
    expect(product?.description).toContain('Calabresa');
    expect(product?.variations[0]?.price).toBe(30);
  });
});
