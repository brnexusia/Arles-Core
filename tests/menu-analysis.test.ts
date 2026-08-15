import { describe, expect, it } from 'vitest';
import {
  applyPricingAudit,
  cleanMenuResult,
  mergeMenuResults
} from '../src/verticals/delivery/menu/menu-analysis.normalize.js';

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

  it('entende preços brasileiros com vírgula e símbolo de moeda', () => {
    const result = cleanMenuResult({
      categories: [{
        name: 'Lanches',
        products: [{
          name: 'X-Bacon',
          description: '',
          price: 'R$ 19,90',
          available: true,
          variations: []
        }]
      }]
    });

    expect(result.categories[0]?.products[0]?.price).toBe(19.9);
  });

  it('junta categorias equivalentes no singular e plural', () => {
    const result = mergeMenuResults(
      cleanMenuResult({ categories: [{ name: 'Bebida', products: [{ name: 'Água', description: '', price: 4, available: true, variations: [] }] }] }),
      cleanMenuResult({ categories: [{ name: 'Bebidas', products: [{ name: 'Suco', description: '', price: 7, available: true, variations: [] }] }] })
    );

    expect(result.categories).toHaveLength(1);
    expect(result.categories[0]?.products).toHaveLength(2);
  });

  it('remove duplicata causada por pequena diferença de OCR entre recortes', () => {
    const result = mergeMenuResults(
      cleanMenuResult({ categories: [{ name: 'Lanches', products: [{ name: 'X-Bacon', description: '', price: 18, available: true, variations: [] }] }] }),
      cleanMenuResult({ categories: [{ name: 'Lanches', products: [{ name: 'X-Bacom', description: 'Hambúrguer, bacon e queijo', price: 18, available: true, variations: [] }] }] })
    );

    expect(result.categories[0]?.products).toHaveLength(1);
    expect(result.categories[0]?.products[0]?.description).toContain('bacon');
  });

  it('não confunde volumes diferentes durante a deduplicação aproximada', () => {
    const result = cleanMenuResult({
      categories: [{
        name: 'Bebidas',
        products: [
          { name: 'Coca-Cola 1L', description: '', price: 10, available: true, variations: [] },
          { name: 'Coca-Cola 2L', description: '', price: 10, available: true, variations: [] }
        ]
      }]
    });

    expect(result.categories[0]?.products).toHaveLength(2);
  });

  it('transforma categorias Pizzas M/G/GG em variações de um único produto', () => {
    const result = cleanMenuResult({
      categories: [
        { name: 'Pizzas M', products: [{ name: 'Calabresa', description: 'Calabresa e cebola', price: 25, available: true, variations: [] }] },
        { name: 'Pizzas G', products: [{ name: 'Calabresa', description: 'Calabresa e cebola', price: 30, available: true, variations: [] }] },
        { name: 'Pizzas GG', products: [{ name: 'Calabresa', description: 'Calabresa e cebola', price: 40, available: true, variations: [] }] }
      ]
    });

    expect(result.categories).toHaveLength(1);
    expect(result.categories[0]?.name).toBe('Pizzas');
    const product = result.categories[0]?.products[0];
    expect(product?.price).toBe(25);
    expect(product?.variations).toEqual(expect.arrayContaining([
      { name: 'M', price: 25 },
      { name: 'G', price: 30 },
      { name: 'GG', price: 40 }
    ]));
  });

  it('recupera M/G/GG mesmo quando a leitura principal só trouxe GG', () => {
    const menu = cleanMenuResult({
      categories: [{
        name: 'Pizzas GG',
        products: [{ name: 'À Moda da Casa', description: 'Presunto e calabresa', price: 40, available: true, variations: [] }]
      }]
    });

    const result = applyPricingAudit(menu, {
      global_variation_groups: [{
        name: 'Tamanhos de pizza',
        category_hint: 'Pizzas',
        applies_to_all_products_in_category: true,
        product_names: [],
        variations: [
          { name: 'M', price: 25 },
          { name: 'G', price: 30 },
          { name: 'GG', price: 40 }
        ]
      }],
      surcharges: [],
      standalone_products: []
    });

    const product = result.categories[0]?.products[0];
    expect(result.categories[0]?.name).toBe('Pizzas');
    expect(product?.price).toBe(25);
    expect(product?.variations.map(v => `${v.name}:${v.price}`)).toEqual(
      expect.arrayContaining(['M:25', 'G:30', 'GG:40'])
    );
  });

  it('recupera bebidas do rodapé como produtos e variações', () => {
    const result = applyPricingAudit(
      { categories: [{ name: 'Pizzas', products: [{ name: 'Baiana', description: '', price: 25, available: true, variations: [] }] }] },
      {
        global_variation_groups: [],
        surcharges: [],
        standalone_products: [
          {
            category: 'Bebidas',
            name: 'Refrigerante',
            description: '',
            price: 4,
            available: true,
            variations: [
              { name: 'Lata', price: 4 },
              { name: '1L', price: 7 },
              { name: '2L', price: 10 }
            ]
          },
          {
            category: 'Bebidas',
            name: 'Suco de Laranja',
            description: '1 litro',
            price: 10,
            available: true,
            variations: []
          }
        ]
      }
    );

    const drinks = result.categories.find(category => category.name === 'Bebidas');
    expect(drinks?.products.map(product => product.name)).toEqual(
      expect.arrayContaining(['Refrigerante', 'Suco de Laranja'])
    );
    const soda = drinks?.products.find(product => product.name === 'Refrigerante');
    expect(soda?.variations).toHaveLength(3);
  });

  it('aplica acréscimo específico às variações globais', () => {
    const result = applyPricingAudit(
      { categories: [{ name: 'Pizzas', products: [{ name: 'Carne de Sol', description: '', price: 40, available: true, variations: [] }] }] },
      {
        global_variation_groups: [{
          name: 'Tamanhos',
          category_hint: 'Pizzas',
          applies_to_all_products_in_category: true,
          product_names: [],
          variations: [
            { name: 'M', price: 25 },
            { name: 'G', price: 30 },
            { name: 'GG', price: 40 }
          ]
        }],
        surcharges: [{ product_name: 'Carne de Sol', amount: 5 }],
        standalone_products: []
      }
    );

    const product = result.categories[0]?.products[0];
    expect(product?.price).toBe(30);
    expect(product?.variations.map(v => v.price)).toEqual(expect.arrayContaining([30, 35, 45]));
  });
});
