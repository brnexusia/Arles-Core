import { db } from '../../infrastructure/db.js';

function clean(value: unknown): string { return String(value ?? '').trim(); }
function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function digits(value: unknown): string { return clean(value).replace(/\D/g, ''); }

const ACTIVE_APPOINTMENT_STATUSES = ['scheduled', 'confirmed'];

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
        join beauty_services s on s.id=a.service_id and s.company_id=a.company_id
        join beauty_professionals p on p.id=a.professional_id and p.company_id=a.company_id
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
      coalesce(array_agg(distinct ps.service_id::text) filter(where ps.service_id is not null),array[]::text[]) service_ids,
      coalesce(jsonb_agg(distinct jsonb_build_object('weekday',a.weekday,'start_time',a.start_time,'end_time',a.end_time,'slot_interval_minutes',a.slot_interval_minutes))
        filter(where a.id is not null),'[]'::jsonb) availability
      from beauty_professionals p
      left join beauty_professional_services ps on ps.professional_id=p.id
      left join beauty_availability a on a.professional_id=p.id and a.company_id=p.company_id and a.active=true
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

  async customers(companyId: string, limit = 200) {
    return (await db.query(`select id::text,name,phone_number,notes,first_seen_at,last_seen_at,created_at
      from contacts where company_id=$1 order by last_seen_at desc limit $2`, [companyId, Math.min(Math.max(limit, 1), 500)])).rows;
  }

  async appointments(companyId: string, from?: string, to?: string) {
    return (await db.query(`select a.id::text,a.customer_name,a.customer_phone,a.starts_at,a.ends_at,a.status,a.notes,a.source,
      s.id::text service_id,s.name service_name,s.price::float,p.id::text professional_id,p.name professional_name
      from beauty_appointments a
      join beauty_services s on s.id=a.service_id and s.company_id=a.company_id
      join beauty_professionals p on p.id=a.professional_id and p.company_id=a.company_id
      where a.company_id=$1 and ($2::timestamptz is null or a.starts_at >= $2) and ($3::timestamptz is null or a.starts_at <= $3)
      order by a.starts_at`, [companyId,from||null,to||null])).rows;
  }

  async availableSlots(companyId: string, input: { serviceId: string; date: string; professionalId?: string; limit?: number }) {
    const date = clean(input.date);
    const serviceId = clean(input.serviceId);
    const professionalId = clean(input.professionalId) || null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('DATE_INVALID');
    if (!serviceId) throw new Error('SERVICE_REQUIRED');

    const service = await db.query(`select 1 from beauty_services where company_id=$1 and id=$2 and active=true`, [companyId, serviceId]);
    if (!service.rowCount) throw new Error('SERVICE_NOT_FOUND');

    const result = await db.query(`
      with eligible as (
        select p.id professional_id,p.name professional_name,s.duration_minutes,c.timezone,
          coalesce(bs.booking_notice_minutes,60) booking_notice_minutes,
          a.start_time,a.end_time,a.slot_interval_minutes
        from beauty_professionals p
        join beauty_professional_services ps on ps.professional_id=p.id and ps.service_id=$2
        join beauty_services s on s.id=ps.service_id and s.company_id=p.company_id and s.active=true
        join companies c on c.id=p.company_id
        left join beauty_settings bs on bs.company_id=p.company_id
        join beauty_availability a on a.professional_id=p.id and a.company_id=p.company_id and a.active=true
          and a.weekday=extract(dow from $3::date)::int
        where p.company_id=$1 and p.active=true and ($4::uuid is null or p.id=$4::uuid)
      ), slots as (
        select e.*,
          gs as starts_at,
          gs + e.duration_minutes * interval '1 minute' as ends_at
        from eligible e
        cross join lateral generate_series(
          (($3::date + e.start_time)::timestamp at time zone e.timezone),
          (($3::date + e.end_time)::timestamp at time zone e.timezone) - e.duration_minutes * interval '1 minute',
          e.slot_interval_minutes * interval '1 minute'
        ) gs
      )
      select professional_id::text,professional_name,starts_at,ends_at
      from slots s
      where s.starts_at >= now() + s.booking_notice_minutes * interval '1 minute'
        and not exists (
          select 1 from beauty_appointments a
          where a.company_id=$1 and a.professional_id=s.professional_id
            and a.status = any($5::text[])
            and a.starts_at < s.ends_at and a.ends_at > s.starts_at
        )
      order by starts_at,professional_name
      limit $6`, [companyId, serviceId, date, professionalId, ACTIVE_APPOINTMENT_STATUSES, Math.min(Math.max(input.limit || 30, 1), 100)]);
    return result.rows;
  }

  private async slotIsAllowed(client: any, companyId: string, serviceId: string, professionalId: string, starts: Date, excludeAppointmentId?: string) {
    const result = await client.query(`
      select s.duration_minutes,c.timezone,coalesce(bs.booking_notice_minutes,60) booking_notice_minutes
      from beauty_services s
      join beauty_professional_services ps on ps.service_id=s.id
      join beauty_professionals p on p.id=ps.professional_id and p.company_id=s.company_id
      join companies c on c.id=s.company_id
      left join beauty_settings bs on bs.company_id=s.company_id
      where s.company_id=$1 and s.id=$2 and s.active=true
        and p.id=$3 and p.active=true
        and exists (
          select 1 from beauty_availability av
          where av.company_id=$1 and av.professional_id=p.id and av.active=true
            and av.weekday=extract(dow from ($4::timestamptz at time zone c.timezone))::int
            and ($4::timestamptz at time zone c.timezone)::time >= av.start_time
            and (($4::timestamptz + s.duration_minutes * interval '1 minute') at time zone c.timezone)::time <= av.end_time
            and mod(
              extract(epoch from ((($4::timestamptz at time zone c.timezone)::time - av.start_time)))::int / 60,
              av.slot_interval_minutes
            ) = 0
        )
      limit 1`, [companyId, serviceId, professionalId, starts]);
    const row = result.rows[0] as { duration_minutes: number; booking_notice_minutes: number } | undefined;
    if (!row) throw new Error('SLOT_NOT_AVAILABLE');
    if (starts.getTime() < Date.now() + Number(row.booking_notice_minutes || 60) * 60000) throw new Error('BOOKING_NOTICE_NOT_MET');
    const ends = new Date(starts.getTime() + Number(row.duration_minutes) * 60000);
    const conflict = await client.query(`select 1 from beauty_appointments where company_id=$1 and professional_id=$2
      and status = any($5::text[]) and starts_at < $4 and ends_at > $3
      and ($6::uuid is null or id <> $6::uuid) limit 1`, [companyId,professionalId,starts,ends,ACTIVE_APPOINTMENT_STATUSES,excludeAppointmentId||null]);
    if (conflict.rowCount) throw new Error('APPOINTMENT_CONFLICT');
    return { ends };
  }

  async createAppointment(companyId: string, body: Record<string, unknown>) {
    const serviceId = clean(body.service_id);
    const professionalId = clean(body.professional_id);
    const starts = new Date(clean(body.starts_at));
    if (!serviceId) throw new Error('SERVICE_REQUIRED');
    if (!professionalId) throw new Error('PROFESSIONAL_REQUIRED');
    if (Number.isNaN(starts.getTime())) throw new Error('START_TIME_INVALID');
    const phone = digits(body.customer_phone);
    if (phone.length < 10) throw new Error('CUSTOMER_PHONE_INVALID');
    const customerName = clean(body.customer_name) || 'Cliente';

    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`beauty:${companyId}:${professionalId}:${starts.toISOString()}`]);
      const { ends } = await this.slotIsAllowed(client, companyId, serviceId, professionalId, starts);
      const contact = await client.query<{id:string}>(`insert into contacts(company_id,name,phone_number,last_seen_at)
        values($1,$2,$3,now()) on conflict(company_id,phone_number) do update set name=excluded.name,last_seen_at=now(),updated_at=now() returning id::text`,[companyId,customerName,phone]);
      const result = await client.query(`insert into beauty_appointments(company_id,contact_id,service_id,professional_id,customer_name,customer_phone,starts_at,ends_at,status,notes,source)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id::text,status,starts_at,ends_at`,[
        companyId,contact.rows[0]?.id,serviceId,professionalId,customerName,phone,starts,ends,
        clean(body.status)||'scheduled',clean(body.notes)||null,clean(body.source)||'panel'
      ]);
      await client.query('commit');
      return result.rows[0];
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }

  async updateAppointment(companyId:string,id:string,body:Record<string,unknown>){
    const client = await db.connect();
    try {
      await client.query('begin');
      const current = await client.query<any>(`select id::text,service_id::text,professional_id::text,starts_at,status,notes
        from beauty_appointments where company_id=$1 and id=$2 for update`, [companyId,id]);
      const appointment = current.rows[0];
      if (!appointment) throw new Error('APPOINTMENT_NOT_FOUND');

      const serviceId = clean(body.service_id) || appointment.service_id;
      const professionalId = clean(body.professional_id) || appointment.professional_id;
      const starts = body.starts_at === undefined ? new Date(appointment.starts_at) : new Date(clean(body.starts_at));
      if (Number.isNaN(starts.getTime())) throw new Error('START_TIME_INVALID');
      const scheduleChanged = serviceId !== appointment.service_id || professionalId !== appointment.professional_id || starts.getTime() !== new Date(appointment.starts_at).getTime();

      let ends: Date | null = null;
      if (scheduleChanged) {
        await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`beauty:${companyId}:${professionalId}:${starts.toISOString()}`]);
        ends = (await this.slotIsAllowed(client, companyId, serviceId, professionalId, starts, id)).ends;
      }

      const status = body.status === undefined ? appointment.status : clean(body.status);
      const notes = body.notes === undefined ? appointment.notes : clean(body.notes) || null;
      const result=await client.query(`update beauty_appointments set
          service_id=$3,professional_id=$4,starts_at=$5,ends_at=coalesce($6,ends_at),status=$7,notes=$8,updated_at=now()
        where company_id=$1 and id=$2 returning id::text,status,notes,starts_at,ends_at,service_id::text,professional_id::text`,
        [companyId,id,serviceId,professionalId,starts,ends,status,notes]);
      await client.query('commit');
      return result.rows[0];
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }

  async findCustomerAppointments(companyId: string, phoneInput: string) {
    const phone = digits(phoneInput);
    if (phone.length < 10) return [];
    return (await db.query(`select a.id::text,a.starts_at,a.ends_at,a.status,
      s.id::text service_id,s.name service_name,s.price::float,
      p.id::text professional_id,p.name professional_name
      from beauty_appointments a
      join beauty_services s on s.id=a.service_id and s.company_id=a.company_id
      join beauty_professionals p on p.id=a.professional_id and p.company_id=a.company_id
      where a.company_id=$1 and right(regexp_replace(a.customer_phone,'[^0-9]','','g'),11)=right($2,11)
        and a.status in ('scheduled','confirmed') and a.starts_at >= now() - interval '1 hour'
      order by a.starts_at limit 20`, [companyId,phone])).rows;
  }

  async settings(companyId:string){
    return (await db.query(`select business_name,address,instagram,cancellation_policy,booking_notice_minutes from beauty_settings where company_id=$1`,[companyId])).rows[0] ?? {};
  }
  async saveSettings(companyId:string,body:Record<string,unknown>){
    await db.query(`insert into beauty_settings(company_id,business_name,address,instagram,cancellation_policy,booking_notice_minutes,updated_at)
      values($1,$2,$3,$4,$5,$6,now()) on conflict(company_id) do update set business_name=excluded.business_name,address=excluded.address,instagram=excluded.instagram,cancellation_policy=excluded.cancellation_policy,booking_notice_minutes=excluded.booking_notice_minutes,updated_at=now()`,
      [companyId,clean(body.business_name)||null,clean(body.address)||null,clean(body.instagram)||null,clean(body.cancellation_policy)||null,Math.max(0,number(body.booking_notice_minutes,60))]);
    return this.settings(companyId);
  }
}

export const beautyService = new BeautyService();
