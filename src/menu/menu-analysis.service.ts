import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { redis } from '../infrastructure/redis.js';

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

export type MenuInputImage = {
  data: string;
  mime: string;
  label?: string;
  isOriginal?: boolean;
};

type MenuAnalysisJob =
  | { status: 'processing'; createdAt: string }
  | { status: 'done'; createdAt: string; data: MenuResult }
  | { status: 'error'; createdAt: string; error: string };

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 28 * 1024 * 1024;
const JOB_TTL_SECONDS = 15 * 60;

const schema = {
  name: 'menu_extraction',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      categories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            products: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  price: { type: ['number', 'null'] },
                  available: { type: 'boolean' },
                  variations: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        price: { type: 'number' }
                      },
                      required: ['name', 'price'],
                      additionalProperties: false
                    }
                  }
                },
                required: ['name', 'description', 'price', 'available', 'variations'],
                additionalProperties: false
              }
            }
          },
          required: ['name', 'products'],
          additionalProperties: false
        }
      }
    },
    required: ['categories'],
    additionalProperties: false
  }
};

const extractionRules = `Você extrai cardápios brasileiros com máxima fidelidade.
Leia TODA a imagem: topo, centro, rodapé, laterais, colunas, blocos pequenos, bebidas, adicionais e categorias doces.
Todas as imagens recebidas pertencem ao MESMO cardápio; algumas são recortes ampliados e se sobrepõem.
Não duplique itens por causa dos recortes.
Cada produto deve ficar na categoria visual correta.
Extraia nome, descrição/ingredientes, preço, disponibilidade e variações/tamanhos.
Não invente informações que não estejam visíveis.
Ignore telefone, endereço, Instagram, slogans e textos promocionais que não sejam produtos.
Se não houver descrição visível, use "".
Se um produto realmente não tiver preço legível e não houver regra de preço aplicável, use null.
available=true, exceto quando estiver explicitamente marcado como indisponível/esgotado.

REGRA MUITO IMPORTANTE SOBRE TAMANHOS/PREÇOS:
Quando o cardápio mostrar uma lista de sabores e, em outra área, uma tabela de tamanhos/preços que vale para TODOS esses sabores (ex.: Pizza M R$25, G R$30, GG R$40), aplique essa tabela a CADA sabor.
Nesse caso, em cada sabor use price = o menor preço/base e variations = todos os tamanhos com seus preços ABSOLUTOS, incluindo o tamanho base.
Exemplo: {"name":"Calabresa","price":25,"variations":[{"name":"M","price":25},{"name":"G","price":30},{"name":"GG","price":40}]}.
Se houver acréscimo específico visível em um sabor (ex.: +R$5), aplique o acréscimo de forma coerente aos tamanhos afetados; não ignore esse texto.
Para bebidas com volumes e preços diferentes, use produtos/variações de forma que nenhum preço visível seja perdido.`;

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

export function mergeMenuResults(...menus: MenuResult[]): MenuResult {
  return dedupeMenu({ categories: menus.flatMap(menu => menu.categories) });
}

function countProducts(menu: MenuResult): number {
  return menu.categories.reduce((sum, category) => sum + category.products.length, 0);
}

function rawBase64(data: string): string {
  return data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
}

function validateImages(images: MenuInputImage[]): void {
  if (!images.length) throw new Error('Nenhuma imagem recebida.');
  let total = 0;

  for (const image of images) {
    if (!ALLOWED_MIMES.has(String(image.mime ?? '').toLowerCase())) {
      throw new Error('Formato de imagem inválido. Use JPG, PNG ou WEBP.');
    }
    const bytes = Math.ceil((rawBase64(String(image.data ?? '')).length * 3) / 4);
    if (!bytes || bytes > MAX_IMAGE_BYTES) {
      throw new Error('Uma das imagens é grande demais para análise.');
    }
    total += bytes;
  }

  if (total > MAX_TOTAL_BYTES) {
    throw new Error('As imagens juntas ficaram grandes demais. Envie menos fotos por vez.');
  }
}

function jobKey(companyId: string, jobId: string): string {
  return `arles:menu-analysis:${companyId}:${jobId}`;
}

async function saveJob(companyId: string, jobId: string, job: MenuAnalysisJob): Promise<void> {
  await redis.set(jobKey(companyId, jobId), JSON.stringify(job), 'EX', JOB_TTL_SECONDS);
}

async function callOpenAI(
  images: MenuInputImage[],
  instruction: string
): Promise<MenuResult> {
  if (!env.openaiApiKey) throw new Error('OPENAI_API_KEY não configurada no Arles Engine.');

  const content: any[] = [
    { type: 'text', text: `${extractionRules}\n\n${instruction}` }
  ];

  images.forEach((image, index) => {
    content.push({ type: 'text', text: image.label || `Imagem ${index + 1}` });
    const url = String(image.data).startsWith('data:')
      ? String(image.data)
      : `data:${image.mime};base64,${image.data}`;
    content.push({ type: 'image_url', image_url: { url, detail: 'high' } });
  });

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.openaiApiKey}`
    },
    body: JSON.stringify({
      model: env.openaiModel,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_schema', json_schema: schema },
      temperature: 0,
      max_tokens: 12000
    }),
    signal: AbortSignal.timeout(120_000)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI ${response.status}: ${body.slice(0, 500)}`);
  }

  const json = await response.json() as any;
  const text = String(json?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('A IA não retornou o cardápio.');

  try {
    return cleanMenuResult(JSON.parse(text));
  } catch {
    throw new Error('A IA retornou um resultado inválido para o cardápio.');
  }
}

async function analyze(images: MenuInputImage[]): Promise<MenuResult> {
  const originals = images.filter(image => image.isOriginal);
  const firstPassImages = originals.length ? originals : images.slice(0, 1);

  const baseline = await callOpenAI(
    firstPassImages,
    'Faça uma leitura estrutural completa. Identifique todas as categorias, todos os sabores/produtos, todas as descrições e TODAS as regras globais de preço/tamanho visíveis.'
  );

  let audit: MenuResult | null = null;
  try {
    audit = await callOpenAI(
      images,
      `Faça uma auditoria final usando a imagem completa e os recortes ampliados.\n` +
      `A primeira leitura foi:\n${JSON.stringify(baseline)}\n\n` +
      'Devolva o cardápio COMPLETO corrigido. Procure itens do rodapé, bebidas, doces, adicionais e sabores omitidos. Verifique especialmente tabelas globais de tamanhos/preços e aplique-as aos produtos correspondentes. Não duplique itens dos recortes.'
    );
  } catch (error) {
    console.warn('[MENU ANALYSIS] auditoria falhou; usando leitura inicial', error);
  }

  const merged = audit ? mergeMenuResults(baseline, audit) : baseline;
  const baselineCount = countProducts(baseline);
  const auditCount = audit ? countProducts(audit) : 0;
  const mergedCount = countProducts(merged);

  console.log(
    `[MENU ANALYSIS] baseline=${baselineCount} audit=${auditCount} final=${mergedCount} categories=${merged.categories.length}`
  );

  if (!mergedCount) throw new Error('Nenhum produto foi identificado no cardápio.');
  return merged;
}

export class MenuAnalysisService {
  async start(companyId: string, images: MenuInputImage[]): Promise<string> {
    validateImages(images);
    const jobId = randomUUID();
    const createdAt = new Date().toISOString();
    await saveJob(companyId, jobId, { status: 'processing', createdAt });

    // Importante: o request HTTP termina imediatamente. A análise continua no Engine,
    // evitando o timeout curto das Netlify Functions.
    setImmediate(() => {
      void analyze(images)
        .then(data => saveJob(companyId, jobId, { status: 'done', createdAt, data }))
        .catch(async error => {
          console.error('[MENU ANALYSIS]', error);
          const message = error instanceof Error ? error.message : 'Falha ao analisar cardápio.';
          await saveJob(companyId, jobId, { status: 'error', createdAt, error: message });
        });
    });

    return jobId;
  }

  async get(companyId: string, jobId: string): Promise<MenuAnalysisJob | null> {
    const raw = await redis.get(jobKey(companyId, jobId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MenuAnalysisJob;
    } catch {
      return null;
    }
  }
}

export const menuAnalysisService = new MenuAnalysisService();
