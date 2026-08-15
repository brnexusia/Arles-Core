import { randomUUID } from 'node:crypto';
import { env } from '../../../config/env.js';
import { redis } from '../../../infrastructure/redis.js';
import {
  applyPricingAudit,
  cleanMenuResult,
  cleanPricingAudit,
  countMenuProducts,
  mergeMenuResults,
  type MenuPricingAudit,
  type MenuResult
} from './analysis.normalize.js';

export { applyPricingAudit, cleanMenuResult, cleanPricingAudit, collapseSizedCategories, mergeMenuResults } from './analysis.normalize.js';
export type { MenuVariation, MenuProduct, MenuCategory, MenuPricingAudit, MenuResult } from './analysis.normalize.js';

export type MenuInputImage = {
  data: string;
  mime: string;
  label?: string;
  isOriginal?: boolean;
  sourceIndex?: number;
};

type MenuAnalysisJob =
  | { status: 'processing'; createdAt: string }
  | { status: 'done'; createdAt: string; data: MenuResult }
  | { status: 'error'; createdAt: string; error: string };

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 28 * 1024 * 1024;
const MAX_ANALYSIS_IMAGES = 36;
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


const pricingAuditSchema = {
  name: 'menu_pricing_audit',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      global_variation_groups: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            category_hint: { type: 'string' },
            applies_to_all_products_in_category: { type: 'boolean' },
            product_names: { type: 'array', items: { type: 'string' } },
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
          required: [
            'name',
            'category_hint',
            'applies_to_all_products_in_category',
            'product_names',
            'variations'
          ],
          additionalProperties: false
        }
      },
      surcharges: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            product_name: { type: 'string' },
            amount: { type: 'number' }
          },
          required: ['product_name', 'amount'],
          additionalProperties: false
        }
      },
      standalone_products: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string' },
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
          required: ['category', 'name', 'description', 'price', 'available', 'variations'],
          additionalProperties: false
        }
      }
    },
    required: ['global_variation_groups', 'surcharges', 'standalone_products'],
    additionalProperties: false
  }
};

const extractionRules = `Você extrai cardápios brasileiros com máxima fidelidade.
Leia TODA a imagem: topo, centro, rodapé, laterais, colunas, blocos pequenos, bebidas, adicionais e categorias doces.
Todas as imagens recebidas pertencem ao MESMO cardápio; algumas são recortes ampliados e se sobrepõem.
Não duplique itens por causa dos recortes.
Cada produto deve ficar na categoria SEMÂNTICA correta (ex.: Pizzas, Pizzas Doces, Bebidas).
NUNCA use tamanho/volume como categoria: "Pizzas M", "Pizzas G" e "Pizzas GG" devem ser um produto em "Pizzas" com variações M/G/GG.
Extraia nome, descrição/ingredientes, preço, disponibilidade e variações/tamanhos.
Leia listas em duas ou mais colunas respeitando o alinhamento horizontal entre nome, descrição e preço.
Não associe ao produto o preço da linha de cima ou de baixo. Em dúvida, preserve o produto com price=null.
Remova apenas números usados como índice visual (ex.: "01 -"); preserve números que façam parte real do nome, quantidade ou tamanho.
Preços com vírgula são decimais brasileiros: "15,90" significa 15.90.
"A partir de R$ X" usa X como preço base. Promoção só vira preço quando estiver claramente ligada ao produto.
Combos devem manter no campo description os itens/acompanhamentos que os compõem.
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
Para bebidas com volumes e preços diferentes, use produtos/variações de forma que nenhum preço visível seja perdido.
Faça uma varredura obrigatória do RODAPÉ: refrigerantes, sucos, águas e outros itens pequenos não podem ser omitidos.`;

function rawBase64(data: string): string {
  return data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
}

function validateImages(images: MenuInputImage[]): void {
  if (!images.length) throw new Error('Nenhuma imagem recebida.');
  if (images.length > MAX_ANALYSIS_IMAGES) {
    throw new Error('Foram gerados recortes demais. Envie menos fotos por análise.');
  }
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

function chunkImages(images: MenuInputImage[], size: number): MenuInputImage[][] {
  const chunks: MenuInputImage[][] = [];
  for (let index = 0; index < images.length; index += size) {
    chunks.push(images.slice(index, index + size));
  }
  return chunks;
}

function menuOutline(menu: MenuResult): string {
  return JSON.stringify({
    categories: menu.categories.map(category => ({
      name: category.name,
      products: category.products.map(product => product.name)
    }))
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<Array<R | null>> {
  const results: Array<R | null> = Array(items.length).fill(null);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await mapper(items[index]!, index);
      } catch (error) {
        console.warn(`[MENU ANALYSIS] leitura regional ${index + 1} falhou`, error);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker())
  );
  return results;
}

function pricingAuditImages(images: MenuInputImage[]): MenuInputImage[] {
  const originals = images.filter(image => image.isOriginal);
  const detailCandidates = images.filter(image =>
    !image.isOriginal && /rodap|inferior|direit|esquerd|coluna|lateral/i.test(String(image.label ?? ''))
  );
  const selected = [...originals, ...detailCandidates];
  const seen = new Set<string>();
  return selected.filter(image => {
    const key = String(image.label ?? `${image.sourceIndex}:${image.isOriginal}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function countProductsWithoutPrice(menu: MenuResult): number {
  return menu.categories.reduce(
    (total, category) => total + category.products.filter(product => product.price === null).length,
    0
  );
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


async function callPricingAudit(
  images: MenuInputImage[],
  baseline: MenuResult
): Promise<MenuPricingAudit> {
  if (!env.openaiApiKey) throw new Error('OPENAI_API_KEY não configurada no Arles Engine.');

  const content: any[] = [
    {
      type: 'text',
      text:
        `Você é o AUDITOR DE PREÇOS E RODAPÉ de um cardápio brasileiro.\n` +
        `Não refaça apenas a lista de produtos. Seu trabalho é descobrir estruturas que uma leitura comum costuma perder.\n\n` +
        `LEITURA INICIAL:\n${JSON.stringify(baseline)}\n\n` +
        `REGRAS OBRIGATÓRIAS:\n` +
        `1. Procure tabelas globais de tamanho/preço separadas da lista de sabores, como M/G/GG à direita da arte.\n` +
        `2. Quando os preços valem para todos os sabores de uma categoria, marque applies_to_all_products_in_category=true.\n` +
        `3. Tamanho NÃO é categoria. M, G, GG, 1L, 2L etc. são variações.\n` +
        `4. Procure especialmente RODAPÉ e laterais: refrigerantes, sucos, água, sobremesas, adicionais e combos.\n` +
        `5. standalone_products deve conter itens independentes que podem ter sido omitidos na leitura inicial.\n` +
        `6. Se houver um acréscimo explícito ligado a um sabor (ex.: Carne de Sol +R$5), coloque em surcharges.\n` +
        `7. Não invente preço nem produto. Se um texto for só título/promocional, não crie produto.\n` +
        `8. Para refrigerante com Lata/1L/2L, prefira UM produto com variações, salvo se a arte realmente mostrar marcas com preços próprios.\n` +
        `9. Se um produto da leitura inicial estiver com price=null ou preço diferente do claramente visível, inclua-o em standalone_products com categoria, nome e preço corrigidos.`
    }
  ];

  for (const [index, image] of images.entries()) {
    content.push({ type: 'text', text: image.label || `Imagem ${index + 1}` });
    const url = String(image.data).startsWith('data:')
      ? String(image.data)
      : `data:${image.mime};base64,${image.data}`;
    content.push({ type: 'image_url', image_url: { url, detail: 'high' } });
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.openaiApiKey}`
    },
    body: JSON.stringify({
      model: env.openaiModel,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_schema', json_schema: pricingAuditSchema },
      temperature: 0,
      max_tokens: 7000
    }),
    signal: AbortSignal.timeout(120_000)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI pricing audit ${response.status}: ${body.slice(0, 500)}`);
  }

  const json = await response.json() as any;
  const text = String(json?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('A auditoria de preços não retornou resultado.');

  try {
    return cleanPricingAudit(JSON.parse(text));
  } catch {
    throw new Error('A auditoria de preços retornou um resultado inválido.');
  }
}

async function analyze(images: MenuInputImage[]): Promise<MenuResult> {
  const originals = images.filter(image => image.isOriginal);
  const firstPassImages = originals.length ? originals : images.slice(0, 1);
  const enlargedRegions = images.filter(image => !image.isOriginal && !firstPassImages.includes(image));

  const baseline = await callOpenAI(
    firstPassImages,
    `Faça a LEITURA ESTRUTURAL do cardápio completo.
Identifique todas as páginas, categorias, colunas e blocos de produtos antes de extrair.
Percorra cada coluna de cima para baixo e depois avance para a próxima coluna.
Se M/G/GG ou volumes aparecerem separados da lista de sabores, trate como variações, nunca como categorias.
Não pule um produto só porque o preço está pequeno: nesse caso use price=null.`
  );

  const regionBatches = chunkImages(enlargedRegions, 3);
  const recoveredRegions = await mapWithConcurrency(regionBatches, 3, (batch, index) =>
    callOpenAI(
      batch,
      `Esta é a LEITURA REGIONAL ${index + 1} de ${regionBatches.length}. Os recortes estão ampliados e podem se sobrepor.
Extraia TODOS os produtos legíveis nestas regiões, linha por linha, inclusive os sem preço legível.
Não é necessário repetir itens que não aparecem nestes recortes.
Use os títulos de categoria visíveis; quando o título estiver fora do recorte, use esta estrutura já encontrada apenas como contexto:
${menuOutline(baseline)}
Não transforme tamanho, volume, código ou preço em categoria. Não crie telefone, endereço ou chamada promocional como produto.`
    )
  );

  const successfulRegions = recoveredRegions.filter((result): result is MenuResult => result !== null);
  let merged = mergeMenuResults(baseline, ...successfulRegions);

  let gapAudit: MenuResult | null = null;
  try {
    gapAudit = await callOpenAI(
      firstPassImages,
      `Faça a AUDITORIA FINAL DE COBERTURA na imagem completa.
Esta lista já foi obtida da imagem completa e dos recortes:
${menuOutline(merged)}

Devolva SOMENTE produtos ausentes, categorias ausentes ou fatos visíveis que precisam ser corrigidos.
Se nada estiver faltando, devolva {"categories":[]}.
Confira obrigatoriamente: cada coluna, topo, centro, rodapé, bebidas, sobremesas, adicionais, porções e combos.
Não repita toda a lista e não invente nada.`
    );
    merged = mergeMenuResults(merged, gapAudit);
  } catch (error) {
    console.warn('[MENU ANALYSIS] auditoria final de cobertura falhou; mantendo leituras regionais', error);
  }

  let pricingAudit: MenuPricingAudit | null = null;
  try {
    pricingAudit = await callPricingAudit(pricingAuditImages(images), merged);
    merged = applyPricingAudit(merged, pricingAudit);
  } catch (error) {
    console.warn('[MENU ANALYSIS] auditoria de preços/rodapé falhou; mantendo cobertura principal', error);
  }

  const baselineCount = countMenuProducts(baseline);
  const regionalCount = successfulRegions.reduce((total, result) => total + countMenuProducts(result), 0);
  const gapCount = gapAudit ? countMenuProducts(gapAudit) : 0;
  const mergedCount = countMenuProducts(merged);
  const pricingGroups = pricingAudit?.global_variation_groups.length ?? 0;
  const recoveredStandalone = pricingAudit?.standalone_products.length ?? 0;
  const productsWithoutPrice = countProductsWithoutPrice(merged);
  const sourceImages = new Set(
    images.map((image, index) => image.sourceIndex ?? (image.isOriginal ? index : 0))
  ).size;
  const passesCompleted = 1 + successfulRegions.length + Number(gapAudit !== null) + Number(pricingAudit !== null);

  console.log(
    `[MENU ANALYSIS] baseline=${baselineCount} regional=${regionalCount} gap=${gapCount} final=${mergedCount} ` +
    `categories=${merged.categories.length} region_batches=${successfulRegions.length}/${regionBatches.length} ` +
    `price_groups=${pricingGroups} standalone_recovered=${recoveredStandalone} missing_price=${productsWithoutPrice}`
  );

  if (!mergedCount) throw new Error('Nenhum produto foi identificado no cardápio.');
  return {
    ...merged,
    analysis: {
      sourceImages,
      regionsAnalyzed: images.length,
      passesCompleted,
      productsWithoutPrice
    }
  };
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
