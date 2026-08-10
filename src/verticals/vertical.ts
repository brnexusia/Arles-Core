import type { Company, NormalizedMessage } from '../core/types.js';

export interface VerticalContext {
  company: Company;
  message: NormalizedMessage;
  combinedText: string;
}

export interface VerticalHandler {
  handle(context: VerticalContext): Promise<string | null>;
}
