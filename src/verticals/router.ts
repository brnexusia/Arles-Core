import type { VerticalModule } from './vertical.js';

const modules = new Map<string, VerticalModule>();

export function registerVertical(module: VerticalModule): void {
  const id = module.id.trim().toLowerCase();
  if (!id) throw new Error('Vertical sem identificador.');
  if (modules.has(id)) throw new Error(`Vertical duplicada: ${id}`);
  modules.set(id, module);
}

export function getVerticalModule(vertical: string): VerticalModule | null {
  return modules.get(vertical.trim().toLowerCase()) ?? null;
}

export function listVerticalModules(): VerticalModule[] {
  return [...modules.values()];
}

export function clearVerticalRegistryForTests(): void {
  modules.clear();
}
