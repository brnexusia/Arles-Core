import { env } from '../config/env.js';

function numberFromJid(jidOrPhone: string): string {
  return jidOrPhone.replace(/\D/g, '');
}

function pathFor(template: string, instance: string): string {
  return template.replace('{instance}', encodeURIComponent(instance));
}

async function errorBody(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).slice(0, 800);
}

export interface EvolutionMedia {
  base64: string;
  mimeType: string;
}

export class EvolutionClient {
  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      apikey: env.evolutionApiKey
    };
  }

  async sendText(input: { instanceName: string; to: string; text: string }): Promise<void> {
    const endpoint = env.evolutionBaseUrl + pathFor(env.evolutionSendTextPath, input.instanceName);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ number: numberFromJid(input.to), text: input.text })
    });

    if (!response.ok) {
      throw new Error(`Evolution sendText falhou (${response.status}): ${await errorBody(response)}`);
    }
  }

  async sendImage(input: {
    instanceName: string;
    to: string;
    mediaUrl: string;
    caption?: string;
  }): Promise<void> {
    const endpoint = env.evolutionBaseUrl + pathFor(env.evolutionSendMediaPath, input.instanceName);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        number: numberFromJid(input.to),
        mediatype: 'image',
        mimetype: 'image/jpeg',
        media: input.mediaUrl,
        caption: input.caption ?? '',
        fileName: 'cardapio.jpg'
      })
    });

    if (!response.ok) {
      throw new Error(`Evolution sendImage falhou (${response.status}): ${await errorBody(response)}`);
    }
  }

  async getMediaBase64(input: {
    instanceName: string;
    messageId: string;
  }): Promise<EvolutionMedia> {
    const endpoint = env.evolutionBaseUrl + pathFor(env.evolutionMediaBase64Path, input.instanceName);

    const attempts: unknown[] = [
      { message: { key: { id: input.messageId } }, convertToMp4: false },
      { messageId: input.messageId },
      { id: input.messageId }
    ];

    let lastError = '';

    for (const body of attempts) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        lastError = `${response.status}: ${await errorBody(response)}`;
        continue;
      }

      const json = await response.json() as any;
      const data = json?.data ?? json ?? {};
      const base64 = String(
        data?.base64 ??
        data?.media?.base64 ??
        json?.base64 ??
        ''
      ).replace(/^data:[^;]+;base64,/i, '').trim();

      const mimeType = String(
        data?.mimetype ??
        data?.mimeType ??
        data?.contentType ??
        data?.media?.mimetype ??
        'application/octet-stream'
      ).trim();

      if (base64) return { base64, mimeType };
      lastError = 'Resposta da Evolution sem base64.';
    }

    throw new Error(`Evolution getMediaBase64 falhou: ${lastError}`);
  }
}

export const evolution = new EvolutionClient();
