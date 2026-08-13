import { env } from '../../config/env.js';
import { moduleRegistry } from '../modules/registry.js';
import { platformJobService } from './job.service.js';

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function processDueJobs(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const jobs = await platformJobService.claimDue();
    for (const job of jobs) {
      try {
        const handler = moduleRegistry.get(job.moduleKey)?.jobs?.[job.type];
        if (!handler) throw new Error(`JOB_HANDLER_NOT_REGISTERED:${job.moduleKey}:${job.type}`);
        await handler({
          id: job.id,
          companyId: job.companyId,
          type: job.type,
          payload: job.payload,
          attempts: job.attempts
        });
        await platformJobService.complete(job);
      } catch (error) {
        await platformJobService.fail(job, error);
      }
    }
  } finally {
    running = false;
  }
}

export function startPlatformJobWorker(): void {
  if (timer) return;
  timer = setInterval(() => void processDueJobs(), env.jobWorkerIntervalMs);
  (timer as any).unref?.();
  void processDueJobs();
}

export function stopPlatformJobWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
