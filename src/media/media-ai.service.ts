import OpenAI from 'openai';
import { env } from '../config/env.js';

export interface ImageAnalysis {
  description: string;
  rawText: string;
}

export class MediaAiService {
  private client: OpenAI | null;

  constructor() {
    this.client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;
  }

  async analyzeImage(
    base64: string,
    mimeType: string,
    instructions = 'Descreva objetivamente a imagem e os textos visíveis.'
  ): Promise<ImageAnalysis> {
    if (!this.client) {
      return { description: 'Imagem enviada pelo cliente.', rawText: '' };
    }

    const response = await this.client.responses.create({
      model: env.openaiModel,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: instructions
          },
          {
            type: 'input_image',
            image_url: `data:${mimeType || 'image/jpeg'};base64,${base64}`
          }
        ]
      }] as any
    });

    const text = String(response.output_text ?? '').trim();
    const description = text
      .replace(/^\s*(CLASSIFICAÇÃO|CLASSIFICACAO|DESCRIÇÃO|DESCRICAO)\s*:\s*/gim, '')
      .trim() || 'Imagem enviada pelo cliente.';

    return { description, rawText: text };
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
