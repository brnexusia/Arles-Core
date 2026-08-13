import type { FastifyInstance } from 'fastify';
import type { Company, NormalizedMessage } from '../../core/types.js';

export type OutgoingAction =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaUrl: string; caption?: string; fileName?: string };

export interface ModuleResult {
  actions: OutgoingAction[];
  followupEligible?: boolean;
  pauseSeconds?: number;
}

export interface ConversationContext {
  company: Company;
  message: NormalizedMessage;
  combinedText: string;
}

export interface ConversationHandler {
  handle(context: ConversationContext): Promise<ModuleResult | null>;
}

export interface ModuleMetadata {
  name: string;
  description?: string;
  version: string;
  icon?: string;
}

export interface ModuleCapability {
  key: string;
  required?: boolean;
  description?: string;
}

export interface ModuleOnboardingStep {
  key: string;
  scope: 'platform' | 'capability';
  title: string;
  capabilityKey?: string;
  order: number;
}

export interface ModuleUiMetadata {
  entry: string;
  navigation: Array<{ key: string; label: string; icon?: string; order: number }>;
}

export interface ModuleMediaContext {
  company: Company;
  message: NormalizedMessage;
  media: { base64: string; mimeType: string };
}

export interface ModuleMediaResult {
  consumed: boolean;
  messageText?: string;
  actions?: OutgoingAction[];
}

export interface ModuleFollowup {
  type: string;
  runAt: Date;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface ModuleJobContext {
  id: string;
  companyId: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface VerticalModule {
  key: string;
  metadata: ModuleMetadata;
  capabilities: ModuleCapability[];
  conversationHandler?: ConversationHandler;
  media?: {
    policies?: Record<string, unknown>;
    handleImage?(context: ModuleMediaContext): Promise<ModuleMediaResult>;
  };
  beforeConversation?(context: ConversationContext): Promise<ModuleResult | null>;
  createFollowup?(context: ConversationContext, result: ModuleResult): Promise<ModuleFollowup | null>;
  jobs?: Record<string, (context: ModuleJobContext) => Promise<void>>;
  registerRoutes?(app: FastifyInstance): Promise<void> | void;
  events?: string[];
  onboardingSteps?: ModuleOnboardingStep[];
  configuration?: Record<string, unknown>;
  ui?: ModuleUiMetadata;
}

// Nomes antigos mantidos somente como aliases de contrato durante a transição.
export type VerticalResult = ModuleResult;
export type VerticalContext = ConversationContext;
export type VerticalHandler = ConversationHandler;
