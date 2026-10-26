import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { db } from '../infrastructure/db.js';

// Evolution Go identifies each tenant by its own API token, not the global key.
// Tokens never leave the Core or enter browser-side configuration.
export const EVOLUTION_WEBHOOK_EVENTS = ['messages.upsert', 'connection.update'] as const;
export interface EvolutionMedia { base64: string; mimeType: string }

export function cashTypingDelayMs(text: string): number {
  return Math.min(1800, Math.max(800, Math.round(String(text || '').length * 10)));
}

function recipient(to: string): string {
  return to.endsWith('@g.us') ? to : to.replace(/\D/g, '');
}

export class EvolutionClient {
  private async token(instanceName: string): Promise<string> {
    const result = await db.query<{ evolution_token: string | null }>(
      'select evolution_token from whatsapp_connections where instance_name = $1 limit 1',
      [instanceName]
    );
    const token = result.rows[0]?.evolution_token;
    if (!token) throw new Error('EVOLUTION_GO_INSTANCE_TOKEN_MISSING: configure a chave da instância em WhatsApp.');
    return token;
  }

  async requestJson(path: string, options: RequestInit = {}, instanceName?: string): Promise<any> {
    const token = instanceName ? await this.token(instanceName) : env.evolutionApiKey;
    const response = await fetch(`${env.evolutionBaseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        apikey: token,
        ...(options.headers || {})
      }
    });
    const raw = await response.text();
    let data: any;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok) {
      const error = new Error(String(data?.error || data?.message || raw || `Evolution Go HTTP ${response.status}`)) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return data;
  }

  extractQr(data: any): string | null {
    const value = data?.data?.code ?? data?.data?.base64 ?? data?.data?.qrcode?.base64 ??
      data?.data?.qrCode ?? data?.data?.qrcode ??
      data?.base64 ?? data?.qrcode?.base64 ?? data?.qrCode ?? data?.qrcode;
    return typeof value === 'string' && value.length > 20 ? value : null;
  }

  async connectionState(instanceName: string): Promise<any> {
    const result = await this.requestJson('/instance/status', { method: 'GET' }, instanceName);
    const info = result?.data ?? result ?? {};
    const raw = String(info?.state ?? info?.status ?? info?.connectionStatus ?? '').toLowerCase();
    const state = ['connected', 'open', 'online'].includes(raw) || info.connected === true
      ? 'open' : ['connecting', 'pairing'].includes(raw) ? 'connecting' : 'close';
    return { ...result, instance: { state, owner: info?.jid ?? info?.phone ?? info?.owner ?? null } };
  }

  async createInstance(instanceName: string, webhookUrl = ''): Promise<any> {
    const token = randomBytes(32).toString('hex');
    const result = await this.requestJson('/instance/create', {
      method: 'POST',
      body: JSON.stringify({
        name: instanceName,
        token,
        ...(webhookUrl ? { webhook: webhookUrl, webhookEvents: [...EVOLUTION_WEBHOOK_EVENTS] } : {})
      })
    });
    await db.query(
      'update whatsapp_connections set evolution_token = $2, updated_at = now() where instance_name = $1',
      [instanceName, token]
    );
    return result;
  }

  async setWebhook(instanceName: string, webhookUrl: string): Promise<any> {
    // Go has no Evolution v2 /webhook/set/:instance endpoint.
    // /instance/connect updates its webhook subscription using the per-instance key.
    return this.requestJson('/instance/connect', {
      method: 'POST',
      body: JSON.stringify({ webhookUrl, subscribe: [...EVOLUTION_WEBHOOK_EVENTS] })
    }, instanceName);
  }

  async connectInstance(instanceName: string): Promise<any> {
    const result = await this.requestJson('/instance/connect', {
      method: 'POST',
      body: JSON.stringify({
        ...(env.publicBaseUrl ? {
          webhookUrl: `${env.publicBaseUrl}/webhooks/evolution`,
          subscribe: [...EVOLUTION_WEBHOOK_EVENTS]
        } : {})
      })
    }, instanceName);
    const qr = await this.requestJson('/instance/qr', { method: 'GET' }, instanceName).catch(() => ({}));
    return { ...result, qrcode: this.extractQr(qr) || this.extractQr(result) };
  }

  async logoutInstance(instanceName: string): Promise<any> {
    return this.requestJson('/instance/logout', { method: 'DELETE' }, instanceName);
  }

  async sendText(input: { instanceName: string; to: string; text: string }): Promise<void> {
    const to = recipient(input.to);
    await this.requestJson('/send/text', {
      method: 'POST',
      body: JSON.stringify({ number: to, text: input.text, formatJid: !to.endsWith('@g.us') })
    }, input.instanceName);
  }

  async sendImage(input: { instanceName: string; to: string; mediaUrl: string; caption?: string; fileName?: string }): Promise<void> {
    const to = recipient(input.to);
    await this.requestJson('/send/media', {
      method: 'POST',
      body: JSON.stringify({
        number: to, url: input.mediaUrl, type: 'image',
        caption: input.caption ?? '', filename: input.fileName ?? 'cardapio.jpg',
        formatJid: !to.endsWith('@g.us')
      })
    }, input.instanceName);
  }

  async getMediaBase64(input: { instanceName: string; messageId: string; raw?: unknown }): Promise<EvolutionMedia> {
    const raw = input.raw as any;
    const data = raw?.data ?? raw?.body?.data ?? {};
    const media = data?.Message ?? data?.message ?? data?.media ?? {};
    const embedded = media?.base64 ?? data?.base64;
    if (typeof embedded === 'string' && embedded.length > 100) {
      return {
        base64: embedded.replace(/^data:[^;]+;base64,/i, ''),
        mimeType: media?.mimetype || data?.mimetype || 'application/octet-stream'
      };
    }

    const result = await this.requestJson('/message/downloadmedia', {
      method: 'POST',
      body: JSON.stringify({ message: media })
    }, input.instanceName);
    const payload = result?.data ?? result ?? {};
    const base64 = payload?.base64 ?? payload?.media?.base64;
    if (typeof base64 !== 'string' || !base64) {
      throw new Error('Evolution Go não retornou conteúdo da mídia. Verifique o payload de download desta versão.');
    }
    return {
      base64: base64.replace(/^data:[^;]+;base64,/i, ''),
      mimeType: payload?.mimetype ?? payload?.mimeType ?? 'application/octet-stream'
    };
  }
}

export const evolution = new EvolutionClient();
