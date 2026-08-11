import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { redis } from '../infrastructure/redis.js';
import {
  applyPricingAudit,
  cleanMenuResult,
  cleanPricingAudit,
  countMenuProducts,
  mergeMenuResults,
  type MenuPricingAudit,
  type MenuResult
} from './menu-analysis.normalize.js';

export { applyPricingAudit, cleanMenuResult, cleanPricingAudit, collapseSizedCategories, mergeMenuResults } from './menu-analysis.normalize.js';
export type { MenuVariation, MenuProduct, MenuCategory, MenuPricingAudit, MenuResult } from './menu-analysis.normalize.js';

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
        `8. Para refrigerante com Lata/1L/2L, prefira UM produto com variações, salvo se a arte realmente mostrar marcas com preços próprios.`
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

  const baseline = await callOpenAI(
    firstPassImages,
    'Faça uma leitura estrutural completa. Identifique TODAS as categorias e produtos. Se M/G/GG aparecerem separados da lista de sabores, trate como variações, nunca como categorias.'
  );

  let audit: MenuResult | null = null;
  try {
    audit = await callOpenAI(
      images,
      `Faça uma auditoria de COBERTURA usando a imagem completa e todos os recortes ampliados.\n` +
      `A primeira leitura foi:\n${JSON.stringify(baseline)}\n\n` +
      `Devolva o cardápio COMPLETO corrigido. Faça checklist visual: topo, meio, rodapé, esquerda e direita. ` +
      `Procure sabores omitidos, Pizzas Doces, refrigerantes, sucos, águas, adicionais e combos. ` +
      `Tamanhos como M/G/GG e volumes como 1L/2L são VARIAÇÕES e não categorias.`
    );
  } catch (error) {
    console.warn('[MENU ANALYSIS] auditoria de cobertura falhou; usando leitura inicial', error);
  }

  let merged = audit ? mergeMenuResults(baseline, audit) : baseline;

  let pricingAudit: MenuPricingAudit | null = null;
  try {
    pricingAudit = await callPricingAudit(images, merged);
    merged = applyPricingAudit(merged, pricingAudit);
  } catch (error) {
    console.warn('[MENU ANALYSIS] auditoria de preços/rodapé falhou; mantendo cobertura principal', error);
  }

  const baselineCount = countMenuProducts(baseline);
  const auditCount = audit ? countMenuProducts(audit) : 0;
  const mergedCount = countMenuProducts(merged);
  const pricingGroups = pricingAudit?.global_variation_groups.length ?? 0;
  const recoveredStandalone = pricingAudit?.standalone_products.length ?? 0;

  console.log(
    `[MENU ANALYSIS] baseline=${baselineCount} coverage=${auditCount} final=${mergedCount} ` +
    `categories=${merged.categories.length} price_groups=${pricingGroups} standalone_recovered=${recoveredStandalone}`
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
