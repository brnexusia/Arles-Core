import { moduleRegistry } from '../platform/modules/registry.js';
import type { VerticalHandler } from './vertical.js';

export function getVerticalHandler(vertical: string): VerticalHandler | null {
  return moduleRegistry.get(vertical)?.conversationHandler ?? null;
}
