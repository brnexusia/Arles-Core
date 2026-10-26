import { db } from '../infrastructure/db.js';
import { env } from '../config/env.js';
import { logOutgoing } from '../core/message.repository.js';
import {
  followupAlreadySent,
  getLastInbound,
  isConversationPaused,
  markFollowupSent,
  markSystemSending,
  popDueFollowups
} from '../infrastructure/redis.js';
import { evolution } from '../whatsapp/evolution.client.js';

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const jobs = await popDueFollowups();

    for (const job of jobs) {
      const allowed = await db.query(
        `select 1 from companies
         where id=$1 and vertical='delivery' and evolution_instance=$2 limit 1`,
        [job.companyId, job.instanceName]
      );
      // Never deliver stale follow-ups from disabled verticals or other instances.
      if (!allowed.rowCount) continue;

      const [lastInbound, alreadySent, paused] = await Promise.all([
        getLastInbound(job.companyId, job.phone),
        followupAlreadySent(job.companyId, job.phone),
        isConversationPaused(job.companyId, job.phone)
      ]);

      if (alreadySent || paused || lastInbound !== job.sourceMessageId) continue;

      await markSystemSending(job.companyId, job.phone);
      await evolution.sendText({
        instanceName: job.instanceName,
        to: job.replyJid || job.phone,
        text: job.text
      });
      await logOutgoing({ companyId: job.companyId, phone: job.phone, body: job.text });
      await markFollowupSent(job.companyId, job.phone);
    }
  } catch (error) {
    console.error('[FollowupWorker] falha:', error);
  } finally {
    running = false;
  }
}

export function startFollowupWorker(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), env.followupWorkerIntervalMs);
  (timer as any).unref?.();
  void tick();
}

export function stopFollowupWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
