import type { VerticalHandler } from './vertical.js';
import { deliveryHandler } from './delivery/handler.js';

const handlers = new Map<string, VerticalHandler>([
  ['delivery', deliveryHandler]
]);

export function getVerticalHandler(vertical: string): VerticalHandler | null {
  return handlers.get(vertical) ?? null;
}
