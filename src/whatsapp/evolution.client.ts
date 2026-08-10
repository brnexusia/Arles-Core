import { env } from '../config/env.js';

function numberFromJid(jidOrPhone: string): string {
  return jidOrPhone.replace(/\D/g, '');
}

function pathFor(template: string, instance: string): string {
  return template.replace('{instance}', encodeURIComponent(instance));
}

export class EvolutionClient {
  async sendText(input: {
    instanceName: string;
    to: string;
    text: string;
  }): Promise<void> {
    const endpoint =
      env.evolutionBaseUrl +
      pathFor(env.evolutionSendTextPath, input.instanceName);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: env.evolutionApiKey
      },
      body: JSON.stringify({
        number: numberFromJid(input.to),
        text: input.text
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Evolution sendText falhou (${response.status}): ${body.slice(0, 500)}`
      );
    }
  }
}

export const evolution = new EvolutionClient();
