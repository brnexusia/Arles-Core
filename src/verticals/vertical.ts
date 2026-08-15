import type { FastifyInstance } from 'fastify';
import type { Company, NormalizedMessage } from '../core/types.js';
import type {
  ModuleJobContext,
  ModuleOnboardingStep,
  ModuleUiMetadata
} from '../platform/modules/contract.js';

export type OutgoingAction =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaUrl: string; caption?: string; fileName?: string };

export interface FollowupRequest {
  text: string;
  delaySeconds?: number;
}

export interface VerticalResult {
  actions: OutgoingAction[];
  followup?: FollowupRequest;
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

export interface VerticalMedia {
  base64: string;
  mimeType: string;
  description: string;
  looksLikePaymentProof: boolean;
}

export interface VerticalModule extends VerticalHandler {
  id: string;
  name: string;
  version: string;
  capabilities: readonly string[];
  registerRoutes?(app: FastifyInstance): Promise<void> | void;
  handlePendingInteraction?(context: VerticalContext): Promise<VerticalResult | undefined>;
  handleImage?(context: VerticalContext, media: VerticalMedia): Promise<VerticalResult | undefined>;
  jobs?: Record<string, (context: ModuleJobContext) => Promise<void>>;
  onboardingSteps?: ModuleOnboardingStep[];
  ui?: ModuleUiMetadata;
}
