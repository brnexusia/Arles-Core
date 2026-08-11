import type { Company, NormalizedMessage } from '../core/types.js';

export type OutgoingAction =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaUrl: string; caption?: string };

export interface VerticalResult {
  actions: OutgoingAction[];
  followupEligible?: boolean;
  pauseSeconds?: number;
}

export interface VerticalContext {
  company: Company;
  message: NormalizedMessage;
  combinedText: string;
}

export interface VerticalHandler {
  handle(context: VerticalContext): Promise<VerticalResult | null>;
}
