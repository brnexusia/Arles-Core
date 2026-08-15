export type Vertical = string;

export interface Company {
  id: string;
  name: string;
  slug: string;
  vertical: Vertical;
  evolution_instance: string;
  subscription_status: string;
  access_active: boolean;
  trial_ends_at: Date | null;
  timezone: string;
}

export interface NormalizedMessage {
  messageId: string;
  instanceName: string;
  remoteJid: string;
  replyJid: string;
  phone: string;
  pushName: string;
  fromMe: boolean;
  isGroup: boolean;
  isBroadcast: boolean;
  event: string;
  type: 'text' | 'image' | 'audio' | 'unsupported';
  text: string;
  raw: unknown;
}
