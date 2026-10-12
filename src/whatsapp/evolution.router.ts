import { env } from '../config/env.js';
import { db } from '../infrastructure/db.js';
import { EvolutionClient, evolution } from './evolution.client.js';

export type EvolutionClusterConfig = {
  key: string;
  baseUrl: string;
  apiKey: string;
  maxInstances: number;
  metricsUrl?: string;
};

type ClusterMetrics = { cpu: number | null; ram: number | null };

const clients = new Map<string, EvolutionClient>();
let parsedCache: EvolutionClusterConfig[] | null = null;

function parseClusters(): EvolutionClusterConfig[] {
  if (parsedCache) return parsedCache;
  const raw = env.beautyEvolutionClustersJson;
  if (!raw) return (parsedCache = []);
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('BEAUTY_EVOLUTION_CLUSTERS_INVALID_JSON'); }
  if (!Array.isArray(value)) throw new Error('BEAUTY_EVOLUTION_CLUSTERS_INVALID');
  const seen = new Set<string>();
  parsedCache = value.map((item: any, index) => {
    const key = String(item?.key || '').trim();
    const baseUrl = String(item?.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(item?.apiKey || '').trim();
    const maxInstances = Number(item?.maxInstances ?? 20);
    const metricsUrl = String(item?.metricsUrl || '').trim() || undefined;
    if (!key || !baseUrl || !apiKey || !Number.isFinite(maxInstances) || maxInstances < 1) {
      throw new Error(`BEAUTY_EVOLUTION_CLUSTER_INVALID_${index}`);
    }
    if (seen.has(key)) throw new Error(`BEAUTY_EVOLUTION_CLUSTER_DUPLICATE_${key}`);
    seen.add(key);
    return { key, baseUrl, apiKey, maxInstances: Math.floor(maxInstances), metricsUrl };
  });
  return parsedCache;
}

export function beautyEvolutionClusters(): EvolutionClusterConfig[] {
  return [...parseClusters()];
}

export function evolutionForCluster(clusterKey?: string | null): EvolutionClient {
  if (!clusterKey) return evolution;
  const config = parseClusters().find(cluster => cluster.key === clusterKey);
  if (!config) throw new Error(`EVOLUTION_CLUSTER_NOT_FOUND:${clusterKey}`);
  let client = clients.get(clusterKey);
  if (!client) {
    client = new EvolutionClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
    clients.set(clusterKey, client);
  }
  return client;
}

async function readMetrics(cluster: EvolutionClusterConfig): Promise<ClusterMetrics> {
  if (!cluster.metricsUrl) return { cpu: null, ram: null };
  try {
    const response = await fetch(cluster.metricsUrl, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { cpu: null, ram: null };
    const metrics = await response.json() as any;
    const cpuRaw = Number(metrics?.cpu_percent ?? metrics?.cpu);
    const ramRaw = Number(metrics?.ram_percent ?? metrics?.ram);
    return {
      cpu: Number.isFinite(cpuRaw) ? cpuRaw : null,
      ram: Number.isFinite(ramRaw) ? ramRaw : null
    };
  } catch {
    return { cpu: null, ram: null };
  }
}

export async function chooseBeautyEvolutionCluster(): Promise<string | null> {
  const clusters = parseClusters();
  if (!clusters.length) return null;
  const usage = await db.query<{cluster_key:string;count:string}>(`select cluster_key,count(*)::text count
    from whatsapp_connections
    where cluster_key is not null and status in ('connecting','open','connected')
    group by cluster_key`);
  const countByKey = new Map(usage.rows.map(row => [row.cluster_key, Number(row.count)]));
  const metrics = new Map<string, ClusterMetrics>();
  await Promise.all(clusters.map(async cluster => metrics.set(cluster.key, await readMetrics(cluster))));

  const available = clusters
    .map(cluster => {
      const used = countByKey.get(cluster.key) || 0;
      const resource = metrics.get(cluster.key) || { cpu: null, ram: null };
      const cpuPressure = resource.cpu === null ? 0 : resource.cpu / 100;
      const ramPressure = resource.ram === null ? 0 : resource.ram / 100;
      const instancePressure = used / cluster.maxInstances;
      return { cluster, used, ...resource, pressure: Math.max(instancePressure, cpuPressure, ramPressure) };
    })
    .filter(item => item.used < item.cluster.maxInstances)
    // Metrics are optional. When present, avoid assigning new sessions to a VPS
    // already under sustained pressure even if the raw instance count is low.
    .filter(item => (item.cpu === null || item.cpu < 85) && (item.ram === null || item.ram < 85))
    .sort((a,b) => a.pressure - b.pressure || a.used - b.used);
  const selected = available[0];
  if (!selected) throw new Error('EVOLUTION_CLUSTER_CAPACITY_EXHAUSTED');
  return selected.cluster.key;
}

function countInstances(data: any): { total: number; connected: number } {
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  let connected = 0;
  for (const item of list) {
    const state = String(item?.connectionStatus || item?.instance?.state || item?.state || '').toLowerCase();
    if (state === 'open' || state === 'connected') connected += 1;
  }
  return { total: list.length, connected };
}

export async function beautyEvolutionHealth() {
  const clusters = parseClusters();
  if (!clusters.length) {
    const instances = await evolution.fetchInstances().catch(() => []);
    const counts = countInstances(instances);
    return [{ key: 'default', configured_capacity: null, ...counts, cpu: null, ram: null, healthy: true }];
  }

  return Promise.all(clusters.map(async cluster => {
    const client = evolutionForCluster(cluster.key);
    try {
      const [instances, metrics] = await Promise.all([client.fetchInstances(), readMetrics(cluster)]);
      const counts = countInstances(instances);
      return { key: cluster.key, configured_capacity: cluster.maxInstances, ...counts, ...metrics, healthy: true };
    } catch (error) {
      return { key: cluster.key, configured_capacity: cluster.maxInstances, total: 0, connected: 0, cpu: null, ram: null, healthy: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
}
