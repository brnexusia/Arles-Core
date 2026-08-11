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

function norm(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
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

      if (product.description.length > existing.description.length) {
        existing.description = product.description;
      }
      if (product.price !== null) existing.price = product.price;
      existing.available = existing.available && product.available;

      const variationMap = new Map(existing.variations.map(v => [norm(v.name), v]));
      for (const variation of product.variations) {
        const key = norm(variation.name);
        const found = variationMap.get(key);
        if (found) found.price = variation.price;
        else {
          const copy = { ...variation };
          existing.variations.push(copy);
          variationMap.set(key, copy);
        }
      }
    }
  }

  return { categories: [...categories.values()].filter(c => c.products.length > 0) };
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

  return dedupeMenu({ categories });
}

export function mergeMenuResults(...menus: MenuResult[]): MenuResult {
  return dedupeMenu({ categories: menus.flatMap(menu => menu.categories) });
}

export function countMenuProducts(menu: MenuResult): number {
  return menu.categories.reduce((sum, category) => sum + category.products.length, 0);
}
