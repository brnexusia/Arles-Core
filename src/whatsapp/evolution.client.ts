import { env } from '../config/env.js';
import { assertPublicHttpUrl } from '../security/safe-url.js';

function numberFromJid(jidOrPhone: string): string {
  return jidOrPhone.replace(/\D/g, '');
}

function pathFor(template: string, instance: string): string {
  return template.replace('{instance}', encodeURIComponent(instance));
}

async function errorBody(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).slice(0, 800);
}

export const EVOLUTION_WEBHOOK_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_EDITED',
  'MESSAGES_UPDATE',
  'PRESENCE_UPDATE',
  'CONNECTION_UPDATE',
  'QRCODE_UPDATED'
] as const;

export function cashTypingDelayMs(text: string): number {
  const length = String(text ?? '').trim().length;
  return Math.min(1800, Math.max(800, Math.round(length * 10)));
}

export interface EvolutionMedia {
  base64: string;
  mimeType: string;
}

export interface EvolutionClientConfig {
  baseUrl: string;
  apiKey: string;
  sendTextPath?: string;
  sendMediaPath?: string;
  mediaBase64Path?: string;
}

export class EvolutionClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly sendTextPath: string;
  private readonly sendMediaPath: string;
  private readonly mediaBase64Path: string;

  constructor(config?: Partial<EvolutionClientConfig>) {
    this.baseUrl = (config?.baseUrl || env.evolutionBaseUrl).replace(/\/+$/, '');
    this.apiKey = config?.apiKey || env.evolutionApiKey;
    this.sendTextPath = config?.sendTextPath || env.evolutionSendTextPath;
    this.sendMediaPath = config?.sendMediaPath || env.evolutionSendMediaPath;
    this.mediaBase64Path = config?.mediaBase64Path || env.evolutionMediaBase64Path;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      apikey: this.apiKey
    };
  }

  async requestJson(path: string, options: RequestInit = {}): Promise<any> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...this.headers(), ...(options.headers || {}) }
    });
    const text = await response.text().catch(() => '');
    let data: any = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (!response.ok) {
      const error: any = new Error(data?.message || data?.error || text || `Evolution ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  extractQr(data: any): string | null {
    const candidates = [
      data?.qrcode?.base64,
      data?.qrCode?.base64,
      data?.base64,
      typeof data?.qrcode === 'string' ? data.qrcode : null,
      typeof data?.qrCode === 'string' ? data.qrCode : null
    ];
    return candidates.find(value => typeof value === 'string' && value.length > 20) || null;
  }

  async connectionState(instanceName: string): Promise<any> {
    return this.requestJson(`/instance/connectionState/${encodeURIComponent(instanceName)}`, { method: 'GET' });
  }

  async fetchInstances(): Promise<any> {
    return this.requestJson('/instance/fetchInstances', { method: 'GET' });
  }

  async createInstance(instanceName: string, webhookUrl = ''): Promise<any> {
    const body: any = { instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS' };
    if (webhookUrl) {
      body.webhook = {
        enabled: true,
        url: webhookUrl,
        byEvents: false,
        base64: false,
        events: [...EVOLUTION_WEBHOOK_EVENTS]
      };
    }
    return this.requestJson('/instance/create', { method: 'POST', body: JSON.stringify(body) });
  }

  async setWebhook(instanceName: string, webhookUrl: string): Promise<any> {
    return this.requestJson(`/webhook/set/${encodeURIComponent(instanceName)}`, {
      method: 'POST',
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: webhookUrl,
          byEvents: false,
          base64: false,
          events: [...EVOLUTION_WEBHOOK_EVENTS]
        }
      })
    });
  }

  async connectInstance(instanceName: string): Promise<any> {
    return this.requestJson(`/instance/connect/${encodeURIComponent(instanceName)}`, { method: 'GET' });
  }

  async logoutInstance(instanceName: string): Promise<any> {
    return this.requestJson(`/instance/logout/${encodeURIComponent(instanceName)}`, { method: 'DELETE' });
  }

  async sendText(input: { instanceName: string; to: string; text: string }): Promise<void> {
    const endpoint = this.baseUrl + pathFor(this.sendTextPath, input.instanceName);
    const body: { number: string; text: string; delay?: number } = {
      number: numberFromJid(input.to),
      text: input.text
    };

    if (env.cashEvolutionInstance && input.instanceName === env.cashEvolutionInstance) {
      body.delay = cashTypingDelayMs(input.text);
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body)
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
    fileName?: string;
  }): Promise<void> {
    const endpoint = this.baseUrl + pathFor(this.sendMediaPath, input.instanceName);
    const safeMediaUrl = await assertPublicHttpUrl(input.mediaUrl);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        number: numberFromJid(input.to),
        mediatype: 'image',
        mimetype: 'image/jpeg',
        media: safeMediaUrl,
        caption: input.caption ?? '',
        fileName: input.fileName || 'image.jpg'
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
    const endpoint = this.baseUrl + pathFor(this.mediaBase64Path, input.instanceName);

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
