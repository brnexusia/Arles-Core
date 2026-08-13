import { db } from '../../infrastructure/db.js';

function clean(value: unknown): string { return String(value ?? '').trim(); }
function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class BeautyService {
  async overview(companyId: string) {
    const [metrics, upcoming] = await Promise.all([
      db.query(`select
        count(*) filter (where starts_at::date = current_date and status in ('scheduled','confirmed'))::int as today,
        count(*) filter (where starts_at >= now() and status in ('scheduled','confirmed'))::int as upcoming,
        count(*) filter (where starts_at >= date_trunc('month',now()) and status='completed')::int as completed_month,
        coalesce(sum(s.price) filter (where a.starts_at >= date_trunc('month',now()) and a.status='completed'),0)::numeric as revenue_month
        from beauty_appointments a left join beauty_services s on s.id=a.service_id
        where a.company_id=$1`, [companyId]),
      db.query(`select a.id::text,a.customer_name,a.customer_phone,a.starts_at,a.ends_at,a.status,a.notes,
          s.id::text as service_id,s.name as service_name,s.price,
          p.id::text as professional_id,p.name as professional_name
        from beauty_appointments a
        join beauty_services s on s.id=a.service_id
        join beauty_professionals p on p.id=a.professional_id
        where a.company_id=$1 and a.starts_at >= now() - interval '1 day'
        order by a.starts_at limit 100`, [companyId])
    ]);
    return { metrics: metrics.rows[0], appointments: upcoming.rows };
  }

  async services(companyId: string) {
    return (await db.query(`select id::text,name,description,duration_minutes,price::float,active,created_at
      from beauty_services where company_id=$1 order by active desc,name`, [companyId])).rows;
  }

  async saveService(companyId: string, body: Record<string, unknown>, id?: string) {
    const values = [companyId, clean(body.name), clean(body.description) || null,
      Math.round(number(body.duration_minutes, 30)), number(body.price), body.active !== false];
    if (!values[1]) throw new Error('SERVICE_NAME_REQUIRED');
    const result = id
      ? await db.query(`update beauty_services set name=$3,description=$4,duration_minutes=$5,price=$6,active=$7,updated_at=now()
          where company_id=$1 and id=$2 returning id::text,name,description,duration_minutes,price::float,active`, [companyId,id,...values.slice(1)])
      : await db.query(`insert into beauty_services(company_id,name,description,duration_minutes,price,active)
          values($1,$2,$3,$4,$5,$6) returning id::text,name,description,duration_minutes,price::float,active`, values);
    if (!result.rows[0]) throw new Error('SERVICE_NOT_FOUND');
    return result.rows[0];
  }

  async professionals(companyId: string) {
    return (await db.query(`select p.id::text,p.name,p.specialty,p.phone,p.active,
      coalesce(array_agg(ps.service_id::text) filter(where ps.service_id is not null),array[]::text[]) service_ids,
      coalesce(jsonb_agg(jsonb_build_object('weekday',a.weekday,'start_time',a.start_time,'end_time',a.end_time,'slot_interval_minutes',a.slot_interval_minutes)
        order by a.weekday) filter(where a.id is not null),'[]'::jsonb) availability
      from beauty_professionals p
      left join beauty_professional_services ps on ps.professional_id=p.id
      left join beauty_availability a on a.professional_id=p.id and a.active=true
      where p.company_id=$1 group by p.id order by p.active desc,p.name`, [companyId])).rows;
  }

  async saveProfessional(companyId: string, body: Record<string, unknown>, id?: string) {
    const client = await db.connect();
    try {
      await client.query('begin');
      const name = clean(body.name);
      if (!name) throw new Error('PROFESSIONAL_NAME_REQUIRED');
      const result = id
        ? await client.query(`update beauty_professionals set name=$3,specialty=$4,phone=$5,active=$6,updated_at=now()
            where company_id=$1 and id=$2 returning id::text`, [companyId,id,name,clean(body.specialty)||null,clean(body.phone)||null,body.active!==false])
        : await client.query(`insert into beauty_professionals(company_id,name,specialty,phone,active)
            values($1,$2,$3,$4,$5) returning id::text`, [companyId,name,clean(body.specialty)||null,clean(body.phone)||null,body.active!==false]);
      const professionalId = result.rows[0]?.id;
      if (!professionalId) throw new Error('PROFESSIONAL_NOT_FOUND');
      await client.query('delete from beauty_professional_services where professional_id=$1', [professionalId]);
      for (const serviceId of Array.isArray(body.service_ids) ? body.service_ids.map(String) : []) {
        await client.query(`insert into beauty_professional_services(professional_id,service_id)
          select $1,id from beauty_services where id=$2 and company_id=$3 on conflict do nothing`, [professionalId,serviceId,companyId]);
      }
      if (Array.isArray(body.availability)) {
        await client.query('delete from beauty_availability where professional_id=$1', [professionalId]);
        for (const row of body.availability as any[]) {
          await client.query(`insert into beauty_availability(company_id,professional_id,weekday,start_time,end_time,slot_interval_minutes)
            values($1,$2,$3,$4,$5,$6)`, [companyId,professionalId,number(row.weekday),clean(row.start_time),clean(row.end_time),number(row.slot_interval_minutes,30)]);
        }
      }
      await client.query('commit');
      return { id: professionalId };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async appointments(companyId: string, from?: string, to?: string) {
    return (await db.query(`select a.id::text,a.customer_name,a.customer_phone,a.starts_at,a.ends_at,a.status,a.notes,
      s.id::text service_id,s.name service_name,s.price::float,p.id::text professional_id,p.name professional_name
      from beauty_appointments a join beauty_services s on s.id=a.service_id join beauty_professionals p on p.id=a.professional_id
      where a.company_id=$1 and ($2::timestamptz is null or a.starts_at >= $2) and ($3::timestamptz is null or a.starts_at <= $3)
      order by a.starts_at`, [companyId,from||null,to||null])).rows;
  }

  async createAppointment(companyId: string, body: Record<string, unknown>) {
    const service = await db.query<{duration_minutes:number}>(`select duration_minutes from beauty_services where id=$1 and company_id=$2 and active=true`, [body.service_id,companyId]);
    if (!service.rows[0]) throw new Error('SERVICE_NOT_FOUND');
    const starts = new Date(clean(body.starts_at));
    if (Number.isNaN(starts.getTime())) throw new Error('START_TIME_INVALID');
    const ends = new Date(starts.getTime()+service.rows[0].duration_minutes*60000);
    const conflict = await db.query(`select 1 from beauty_appointments where company_id=$1 and professional_id=$2
      and status in ('scheduled','confirmed') and starts_at < $4 and ends_at > $3 limit 1`, [companyId,body.professional_id,starts,ends]);
    if (conflict.rowCount) throw new Error('APPOINTMENT_CONFLICT');
    const phone=clean(body.customer_phone).replace(/\D/g,'');
    const contact=await db.query<{id:string}>(`insert into contacts(company_id,name,phone_number,last_seen_at)
      values($1,$2,$3,now()) on conflict(company_id,phone_number) do update set name=excluded.name,last_seen_at=now(),updated_at=now() returning id::text`,[companyId,clean(body.customer_name)||'Cliente',phone]);
    const result=await db.query(`insert into beauty_appointments(company_id,contact_id,service_id,professional_id,customer_name,customer_phone,starts_at,ends_at,status,notes,source)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id::text`,[companyId,contact.rows[0]?.id,body.service_id,body.professional_id,clean(body.customer_name)||'Cliente',phone,starts,ends,clean(body.status)||'scheduled',clean(body.notes)||null,clean(body.source)||'panel']);
    return result.rows[0];
  }

  async updateAppointment(companyId:string,id:string,body:Record<string,unknown>){
    const result=await db.query(`update beauty_appointments set status=coalesce($3,status),notes=coalesce($4,notes),updated_at=now()
      where company_id=$1 and id=$2 returning id::text,status,notes`,[companyId,id,body.status||null,body.notes===undefined?null:clean(body.notes)]);
    if(!result.rows[0]) throw new Error('APPOINTMENT_NOT_FOUND'); return result.rows[0];
  }

  async settings(companyId:string){
    return (await db.query(`select business_name,address,instagram,cancellation_policy,booking_notice_minutes from beauty_settings where company_id=$1`,[companyId])).rows[0] ?? {};
  }
  async saveSettings(companyId:string,body:Record<string,unknown>){
    await db.query(`insert into beauty_settings(company_id,business_name,address,instagram,cancellation_policy,booking_notice_minutes,updated_at)
      values($1,$2,$3,$4,$5,$6,now()) on conflict(company_id) do update set business_name=excluded.business_name,address=excluded.address,instagram=excluded.instagram,cancellation_policy=excluded.cancellation_policy,booking_notice_minutes=excluded.booking_notice_minutes,updated_at=now()`,
      [companyId,clean(body.business_name)||null,clean(body.address)||null,clean(body.instagram)||null,clean(body.cancellation_policy)||null,number(body.booking_notice_minutes,60)]);
    return this.settings(companyId);
  }
}

export const beautyService = new BeautyService();
