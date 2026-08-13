/** Delivery menu normalization contract. */
export type MenuVariation = {
  name: string;
  price: number;
};

export type MenuProduct = {
  name: string;
  description: string;
  price: number | null;
  available: boolean;
  variations: MenuVariation[];
};

export type MenuCategory = {
  name: string;
  products: MenuProduct[];
};

export type MenuResult = {
  categories: MenuCategory[];
};

export type MenuPricingAudit = {
  global_variation_groups: Array<{
    name: string;
    category_hint: string;
    applies_to_all_products_in_category: boolean;
    product_names: string[];
    variations: MenuVariation[];
  }>;
  surcharges: Array<{
    product_name: string;
    amount: number;
  }>;
  standalone_products: Array<{
    category: string;
    name: string;
    description: string;
    price: number | null;
    available: boolean;
    variations: MenuVariation[];
  }>;
};

function norm(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

function mergeProduct(target: MenuProduct, source: MenuProduct): void {
  if (source.description.length > target.description.length) {
    target.description = source.description;
  }
  if (source.price !== null) target.price = source.price;
  target.available = target.available && source.available;

  const variationMap = new Map(target.variations.map(v => [norm(v.name), v]));
  for (const variation of source.variations) {
    const key = norm(variation.name);
    const found = variationMap.get(key);
    if (found) found.price = variation.price;
    else {
      const copy = { ...variation };
      target.variations.push(copy);
      variationMap.set(key, copy);
    }
  }

  if (target.variations.length) {
    target.price = Math.min(...target.variations.map(v => v.price));
  }
}

function dedupeMenu(menu: MenuResult): MenuResult {
  const categories = new Map<string, MenuCategory>();

  for (const category of menu.categories) {
    const categoryKey = norm(category.name) || 'geral';
    let target = categories.get(categoryKey);
    if (!target) {
      target = { name: category.name, products: [] };
      categories.set(categoryKey, target);
    }

    const productMap = new Map(target.products.map(p => [norm(p.name), p]));
    for (const product of category.products) {
      const productKey = norm(product.name);
      if (!productKey) continue;
      const existing = productMap.get(productKey);

      if (!existing) {
        const copy = { ...product, variations: [...product.variations] };
        target.products.push(copy);
        productMap.set(productKey, copy);
        continue;
      }

      mergeProduct(existing, product);
    }
  }

  return { categories: [...categories.values()].filter(c => c.products.length > 0) };
}

const SIZE_SUFFIX_RE = /^(.*?)(?:\s*[-–—:/|]?\s*)(gg|g|m|p|pequena|media|m[eé]dia|grande|familia|fam[ií]lia|lata|\d+(?:[.,]\d+)?\s*(?:ml|l|lt|litro|litros|cm))$/i;

function canonicalSize(value: string): string {
  const raw = value.trim();
  const n = norm(raw);
  if (['p', 'm', 'g', 'gg'].includes(n)) return n.toUpperCase();
  if (n === 'media') return 'Média';
  if (n === 'familia') return 'Família';
  if (n === 'pequena') return 'Pequena';
  if (n === 'grande') return 'Grande';
  if (n === 'lata') return 'Lata';
  return raw.replace(/\s+/g, ' ').replace(/\blt\b/i, 'L');
}

function parseSizedCategory(name: string): { base: string; size: string } | null {
  const match = name.trim().match(SIZE_SUFFIX_RE);
  if (!match) return null;

  const base = String(match[1] ?? '').replace(/[\s\-–—:/|]+$/g, '').trim();
  const size = canonicalSize(String(match[2] ?? ''));
  if (!base || !size) return null;

  // Evita transformar nomes como "Combo Grande" em regra estrutural quando não há
  // indício de categoria que normalmente usa tamanhos/volumes.
  const baseNorm = norm(base);
  const likelySizedCategory = /(pizza|pizzas|bebida|bebidas|refrigerante|refrigerantes|suco|sucos|acai|açai|lanche|lanches|porcao|porcoes)/.test(baseNorm);
  if (!likelySizedCategory) return null;

  return { base, size };
}

/**
 * Corrige um erro comum de visão: a IA às vezes devolve "Pizzas M", "Pizzas G"
 * e "Pizzas GG" como categorias diferentes. Para o Engine isso é um único produto
 * com variações de tamanho. O mesmo vale para bebidas separadas por volume.
 */
export function collapseSizedCategories(menu: MenuResult): MenuResult {
  const normalCategories: MenuCategory[] = [];
  const sizedCategories = new Map<string, MenuCategory>();

  for (const category of menu.categories) {
    const parsed = parseSizedCategory(category.name);
    if (!parsed) {
      normalCategories.push({
        name: category.name,
        products: category.products.map(product => ({ ...product, variations: [...product.variations] }))
      });
      continue;
    }

    const key = norm(parsed.base);
    let target = sizedCategories.get(key);
    if (!target) {
      target = { name: parsed.base, products: [] };
      sizedCategories.set(key, target);
    }

    const productMap = new Map(target.products.map(product => [norm(product.name), product]));

    for (const source of category.products) {
      const productKey = norm(source.name);
      if (!productKey) continue;

      let product = productMap.get(productKey);
      if (!product) {
        product = {
          name: source.name,
          description: source.description,
          price: source.price,
          available: source.available,
          variations: [...source.variations]
        };
        target.products.push(product);
        productMap.set(productKey, product);
      } else {
        mergeProduct(product, source);
      }

      if (source.price !== null) {
        const sizeKey = norm(parsed.size);
        const existingVariation = product.variations.find(v => norm(v.name) === sizeKey);
        if (existingVariation) existingVariation.price = source.price;
        else product.variations.push({ name: parsed.size, price: source.price });
      }

      if (product.variations.length) {
        product.price = Math.min(...product.variations.map(v => v.price));
      }
    }
  }

  return dedupeMenu({ categories: [...normalCategories, ...sizedCategories.values()] });
}

export function cleanMenuResult(input: unknown): MenuResult {
  const categories: MenuCategory[] = [];
  const rawCategories = Array.isArray((input as any)?.categories)
    ? (input as any).categories
    : [];

  for (const rawCat of rawCategories) {
    const categoryName = String(rawCat?.name ?? '').trim();
    if (!categoryName) continue;

    const products: MenuProduct[] = [];
    const rawProducts = Array.isArray(rawCat?.products) ? rawCat.products : [];

    for (const raw of rawProducts) {
      const name = String(raw?.name ?? '').trim();
      if (!name) continue;

      const variations: MenuVariation[] = [];
      const seenVariations = new Set<string>();
      for (const variation of Array.isArray(raw?.variations) ? raw.variations : []) {
        const variationName = String(variation?.name ?? '').trim();
        const variationPrice = numberOrNull(variation?.price);
        const key = norm(variationName);
        if (!variationName || variationPrice === null || seenVariations.has(key)) continue;
        seenVariations.add(key);
        variations.push({ name: variationName, price: variationPrice });
      }

      let price = numberOrNull(raw?.price);
      if (price === null && variations.length) {
        price = Math.min(...variations.map(v => v.price));
      }

      products.push({
        name,
        description: String(raw?.description ?? '').trim(),
        price,
        available: raw?.available !== false,
        variations
      });
    }

    if (products.length) categories.push({ name: categoryName, products });
  }

  return collapseSizedCategories(dedupeMenu({ categories }));
}

export function mergeMenuResults(...menus: MenuResult[]): MenuResult {
  return collapseSizedCategories(dedupeMenu({ categories: menus.flatMap(menu => menu.categories) }));
}

function categoryMatchesHint(category: string, hint: string): boolean {
  const c = norm(category);
  const h = norm(hint);
  if (!h) return false;
  if (c === h || c.includes(h) || h.includes(c)) return true;

  // Uma tabela "Pizzas" normalmente também vale para "Pizzas Doces",
  // "Pizzas Tradicionais" etc., quando a auditoria marcou aplicação global.
  if (h.includes('pizza') && c.includes('pizza')) return true;
  if (h.includes('refrigerante') && c.includes('refrigerante')) return true;
  if (h.includes('bebida') && c.includes('bebida')) return true;
  return false;
}

function productNameMatches(name: string, expected: string): boolean {
  const a = norm(name);
  const b = norm(expected);
  if (!a || !b) return false;
  return a === b || (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a)));
}

export function cleanPricingAudit(input: unknown): MenuPricingAudit {
  const raw = input as any;
  const groups = Array.isArray(raw?.global_variation_groups) ? raw.global_variation_groups : [];
  const surcharges = Array.isArray(raw?.surcharges) ? raw.surcharges : [];
  const standalone = Array.isArray(raw?.standalone_products) ? raw.standalone_products : [];

  return {
    global_variation_groups: groups
      .map((group: any) => ({
        name: String(group?.name ?? '').trim(),
        category_hint: String(group?.category_hint ?? '').trim(),
        applies_to_all_products_in_category: group?.applies_to_all_products_in_category === true,
        product_names: Array.isArray(group?.product_names)
          ? group.product_names.map((name: unknown) => String(name ?? '').trim()).filter(Boolean)
          : [],
        variations: Array.isArray(group?.variations)
          ? group.variations
              .map((variation: any) => ({
                name: String(variation?.name ?? '').trim(),
                price: numberOrNull(variation?.price)
              }))
              .filter((variation: any) => variation.name && variation.price !== null)
              .map((variation: any) => ({ name: variation.name, price: variation.price as number }))
          : []
      }))
      .filter((group: any) => group.category_hint && group.variations.length > 0),
    surcharges: surcharges
      .map((rule: any) => ({
        product_name: String(rule?.product_name ?? '').trim(),
        amount: numberOrNull(rule?.amount)
      }))
      .filter((rule: any) => rule.product_name && rule.amount !== null)
      .map((rule: any) => ({ product_name: rule.product_name, amount: rule.amount as number })),
    standalone_products: standalone
      .map((product: any) => {
        const variations: MenuVariation[] = Array.isArray(product?.variations)
          ? product.variations
              .map((variation: any) => ({
                name: String(variation?.name ?? '').trim(),
                price: numberOrNull(variation?.price)
              }))
              .filter((variation: any) => variation.name && variation.price !== null)
              .map((variation: any) => ({ name: variation.name, price: variation.price as number }))
          : [];
        let price = numberOrNull(product?.price);
        if (price === null && variations.length) price = Math.min(...variations.map(v => v.price));
        return {
          category: String(product?.category ?? '').trim(),
          name: String(product?.name ?? '').trim(),
          description: String(product?.description ?? '').trim(),
          price,
          available: product?.available !== false,
          variations
        };
      })
      .filter((product: any) => product.category && product.name)
  };
}

/**
 * Aplica regras de preço globais detectadas separadamente da lista de produtos.
 * Isso resolve cardápios em que os sabores estão à esquerda e os preços M/G/GG
 * aparecem uma única vez à direita da arte.
 */
export function applyPricingAudit(menu: MenuResult, auditInput: MenuPricingAudit): MenuResult {
  const audit = cleanPricingAudit(auditInput);
  let result = mergeMenuResults(menu, cleanMenuResult({
    categories: audit.standalone_products.reduce<Array<{ name: string; products: MenuProduct[] }>>((acc, product) => {
      let category = acc.find(item => norm(item.name) === norm(product.category));
      if (!category) {
        category = { name: product.category, products: [] };
        acc.push(category);
      }
      category.products.push({
        name: product.name,
        description: product.description,
        price: product.price,
        available: product.available,
        variations: product.variations
      });
      return acc;
    }, [])
  }));

  for (const group of audit.global_variation_groups) {
    const groupVariations = group.variations
      .filter(variation => Number.isFinite(variation.price))
      .map(variation => ({ ...variation }));
    if (!groupVariations.length) continue;

    for (const category of result.categories) {
      if (!categoryMatchesHint(category.name, group.category_hint)) continue;

      for (const product of category.products) {
        const explicitlyListed = group.product_names.some(name => productNameMatches(product.name, name));
        if (!group.applies_to_all_products_in_category && group.product_names.length && !explicitlyListed) {
          continue;
        }
        if (!group.applies_to_all_products_in_category && !group.product_names.length) continue;

        const variationMap = new Map(product.variations.map(v => [norm(v.name), v]));
        for (const variation of groupVariations) {
          const key = norm(variation.name);
          const found = variationMap.get(key);
          if (found) found.price = variation.price;
          else {
            const copy = { ...variation };
            product.variations.push(copy);
            variationMap.set(key, copy);
          }
        }
        product.price = Math.min(...product.variations.map(v => v.price));
      }
    }
  }

  for (const surcharge of audit.surcharges) {
    for (const category of result.categories) {
      for (const product of category.products) {
        if (!productNameMatches(product.name, surcharge.product_name)) continue;

        if (product.variations.length) {
          product.variations = product.variations.map(variation => ({
            ...variation,
            price: Math.round((variation.price + surcharge.amount) * 100) / 100
          }));
          product.price = Math.min(...product.variations.map(v => v.price));
        } else if (product.price !== null) {
          product.price = Math.round((product.price + surcharge.amount) * 100) / 100;
        }
      }
    }
  }

  return mergeMenuResults(result);
}

export function countMenuProducts(menu: MenuResult): number {
  return menu.categories.reduce((sum, category) => sum + category.products.length, 0);
}
