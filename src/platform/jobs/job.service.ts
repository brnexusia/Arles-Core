import { db } from '../../infrastructure/db.js';

export interface PlatformJob {
  id: string;
  companyId: string;
  moduleKey: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export class PlatformJobService {
  async enqueue(input: {
    companyId: string;
    moduleKey: string;
    type: string;
    payload: Record<string, unknown>;
    runAt: Date;
    idempotencyKey: string;
    maxAttempts?: number;
  }): Promise<string> {
    const result = await db.query<{ id: string }>(
      `insert into platform_jobs(
         company_id,module_key,job_type,payload,run_at,idempotency_key,max_attempts
       ) values($1,$2,$3,$4::jsonb,$5,$6,$7)
       on conflict(company_id,module_key,idempotency_key) do update set
         run_at=least(platform_jobs.run_at,excluded.run_at),
         payload=case
           when platform_jobs.status in ('pending','retry') then excluded.payload
           else platform_jobs.payload
         end,
         updated_at=now()
       returning id::text`,
      [
        input.companyId,
        input.moduleKey,
        input.type,
        JSON.stringify(input.payload),
        input.runAt,
        input.idempotencyKey,
        input.maxAttempts ?? 5
      ]
    );
    return result.rows[0]!.id;
  }

  async claimDue(limit = 25): Promise<PlatformJob[]> {
    const result = await db.query<{
      id: string;
      company_id: string;
      module_key: string;
      job_type: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
    }>(
      `with due as (
         select id
         from platform_jobs
         where status in ('pending','retry') and run_at <= now()
         order by run_at, created_at
         for update skip locked
         limit $1
       )
       update platform_jobs j set
         status='running',
         attempts=j.attempts+1,
         locked_at=now(),
         updated_at=now()
       from due
       where j.id=due.id
       returning j.id::text,j.company_id::text,j.module_key,j.job_type,
                 j.payload,j.attempts,j.max_attempts`,
      [limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      companyId: row.company_id,
      moduleKey: row.module_key,
      type: row.job_type,
      payload: row.payload ?? {},
      attempts: row.attempts,
      maxAttempts: row.max_attempts
    }));
  }

  async complete(job: PlatformJob): Promise<void> {
    await db.query(
      `update platform_jobs set
         status='completed',completed_at=now(),locked_at=null,updated_at=now()
       where id=$1 and status='running'`,
      [job.id]
    );
    await db.query(
      `insert into platform_job_attempts(job_id,attempt,status,finished_at)
       values($1,$2,'completed',now())`,
      [job.id, job.attempts]
    );
  }

  async fail(job: PlatformJob, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
    const dead = job.attempts >= job.maxAttempts;
    const retrySeconds = Math.min(3600, 15 * 2 ** Math.max(0, job.attempts - 1));

    await db.query(
      `update platform_jobs set
         status=$2,
         run_at=case when $2='retry' then now()+($3 * interval '1 second') else run_at end,
         last_error=$4,locked_at=null,updated_at=now()
       where id=$1 and status='running'`,
      [job.id, dead ? 'dead' : 'retry', retrySeconds, message]
    );
    await db.query(
      `insert into platform_job_attempts(job_id,attempt,status,error,finished_at)
       values($1,$2,$3,$4,now())`,
      [job.id, job.attempts, dead ? 'dead' : 'retry', message]
    );
  }
}

export const platformJobService = new PlatformJobService();
