import OpenAI from 'openai';
import { env } from '../config/env.js';

export interface ImageAnalysis {
  looksLikePaymentProof: boolean;
  description: string;
}

export class MediaAiService {
  private client: OpenAI | null;

  constructor() {
    this.client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;
  }

  async analyzeImage(base64: string, mimeType: string): Promise<ImageAnalysis> {
    if (!this.client) {
      return { looksLikePaymentProof: false, description: 'Imagem enviada pelo cliente.' };
    }

    const response = await this.client.responses.create({
      model: env.openaiModel,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Analise a imagem enviada por um cliente. Na PRIMEIRA linha responda exatamente COMPROVANTE_PAGAMENTO: SIM se a imagem parecer um comprovante, recibo, transferência bancária ou tela de pagamento concluído; caso contrário responda exatamente COMPROVANTE_PAGAMENTO: NAO. Na segunda linha escreva DESCRICAO: e descreva objetivamente o que está visível, incluindo textos relevantes. Não afirme que o pagamento foi aprovado; apenas classifique se parece ou não um comprovante.'
          },
          {
            type: 'input_image',
            image_url: `data:${mimeType || 'image/jpeg'};base64,${base64}`
          }
        ]
      }] as any
    });

    const text = String(response.output_text ?? '').trim();
    const looksLikePaymentProof = /COMPROVANTE_PAGAMENTO\s*:\s*SIM/i.test(text);
    const description = text
      .replace(/COMPROVANTE_PAGAMENTO\s*:\s*(SIM|NAO|NÃO)/ig, '')
      .replace(/^\s*DESCRICAO\s*:\s*/im, '')
      .trim() || 'Imagem enviada pelo cliente.';

    return { looksLikePaymentProof, description };
  }

  async transcribeAudio(base64: string, mimeType: string): Promise<string> {
    if (!env.openaiApiKey) return '';

    const bytes = Buffer.from(base64, 'base64');
    const form = new FormData();
    form.append('model', env.openaiTranscribeModel);
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: mimeType || 'audio/ogg' }),
      'audio.ogg'
    );

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.openaiApiKey}` },
      body: form
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Transcrição OpenAI falhou (${response.status}): ${body.slice(0, 500)}`);
    }

    const json = await response.json() as { text?: string };
    return String(json.text ?? '').trim();
  }
}

export const mediaAiService = new MediaAiService();
