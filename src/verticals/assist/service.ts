import { db } from '../../infrastructure/db.js';

const clean=(value:unknown)=>String(value??'').trim();
const num=(value:unknown)=>{const n=Number(value);return Number.isFinite(n)?n:null;};

export type AssistServiceInput={
  category?:unknown;equipment_type?:unknown;brand?:unknown;model_pattern?:unknown;name?:unknown;description?:unknown;
  pricing_mode?:unknown;price_min?:unknown;price_max?:unknown;labor_price?:unknown;parts_price?:unknown;requires_diagnosis?:unknown;active?:unknown;
};

export class AssistService {
  async overview(companyId:string){
    const [metrics,recent]=await Promise.all([
      db.query(`select
        count(*) filter(where status in ('triage','quoted','awaiting_approval'))::int as open_quotes,
        count(*) filter(where status in ('received','diagnosis','approved','repairing'))::int as in_service,
        count(*) filter(where status='ready')::int as ready,
        count(*) filter(where status='delivered' and updated_at>=date_trunc('month',now()))::int as delivered_month,
        coalesce(sum(approved_price) filter(where status='delivered' and updated_at>=date_trunc('month',now())),0)::float as revenue_month
        from assist_orders where company_id=$1`,[companyId]),
      db.query(`select id::text,customer_name,customer_phone,channel,equipment_type,brand,model,reported_issue,
        quoted_min::float,quoted_max::float,approved_price::float,status,updated_at
        from assist_orders where company_id=$1 order by updated_at desc limit 30`,[companyId])
    ]);
    return {metrics:metrics.rows[0],orders:recent.rows};
  }

  async services(companyId:string){
    return (await db.query(`select id::text,category,equipment_type,brand,model_pattern,name,description,pricing_mode,
      price_min::float,price_max::float,labor_price::float,parts_price::float,requires_diagnosis,active,created_at,updated_at
      from assist_services where company_id=$1 order by active desc,equipment_type,brand nulls last,name`,[companyId])).rows;
  }

  async saveService(companyId:string,body:AssistServiceInput,id?:string){
    const name=clean(body.name), category=clean(body.category)||'Geral', equipment=clean(body.equipment_type);
    const pricing=clean(body.pricing_mode)||'diagnosis';
    if(!name) throw new Error('SERVICE_NAME_REQUIRED');
    if(!equipment) throw new Error('EQUIPMENT_TYPE_REQUIRED');
    if(!['exact','range','diagnosis'].includes(pricing)) throw new Error('PRICING_MODE_INVALID');
    const values=[category,equipment,clean(body.brand)||null,clean(body.model_pattern)||null,name,clean(body.description)||null,pricing,
      num(body.price_min),num(body.price_max),num(body.labor_price),num(body.parts_price),Boolean(body.requires_diagnosis),body.active!==false];
    const result=id
      ? await db.query(`update assist_services set category=$3,equipment_type=$4,brand=$5,model_pattern=$6,name=$7,description=$8,pricing_mode=$9,
          price_min=$10,price_max=$11,labor_price=$12,parts_price=$13,requires_diagnosis=$14,active=$15,updated_at=now()
          where company_id=$1 and id=$2 returning id::text`,[companyId,id,...values])
      : await db.query(`insert into assist_services(company_id,category,equipment_type,brand,model_pattern,name,description,pricing_mode,price_min,price_max,labor_price,parts_price,requires_diagnosis,active)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id::text`,[companyId,...values]);
    if(!result.rows[0]) throw new Error('SERVICE_NOT_FOUND');
    return (await db.query(`select id::text,category,equipment_type,brand,model_pattern,name,description,pricing_mode,price_min::float,price_max::float,
      labor_price::float,parts_price::float,requires_diagnosis,active from assist_services where company_id=$1 and id=$2`,[companyId,result.rows[0].id])).rows[0];
  }

  async orders(companyId:string,status?:string){
    return (await db.query(`select o.id::text,o.customer_name,o.customer_phone,o.channel,o.equipment_type,o.brand,o.model,o.serial_number,o.reported_issue,
      o.quoted_min::float,o.quoted_max::float,o.approved_price::float,o.status,o.diagnosis_notes,o.internal_notes,o.promised_at,o.created_at,o.updated_at,
      s.name as probable_service_name
      from assist_orders o left join assist_services s on s.id=o.probable_service_id
      where o.company_id=$1 and ($2::text is null or o.status=$2) order by o.updated_at desc limit 300`,[companyId,status||null])).rows;
  }

  async createOrder(companyId:string,body:Record<string,unknown>){
    const phone=clean(body.customer_phone).replace(/\D/g,'');
    if(!phone) throw new Error('CUSTOMER_PHONE_REQUIRED');
    const customer=clean(body.customer_name)||'Cliente';
    const contact=await db.query<{id:string}>(`insert into contacts(company_id,name,phone_number,last_seen_at)
      values($1,$2,$3,now()) on conflict(company_id,phone_number) do update set name=excluded.name,last_seen_at=now(),updated_at=now() returning id::text`,[companyId,customer,phone]);
    const result=await db.query(`insert into assist_orders(company_id,contact_id,probable_service_id,customer_name,customer_phone,channel,equipment_type,brand,model,serial_number,reported_issue,
      quoted_min,quoted_max,approved_price,status,diagnosis_notes,internal_notes,promised_at,source_message_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning id::text`,[
      companyId,contact.rows[0]?.id,body.probable_service_id||null,customer,phone,clean(body.channel)||'panel',clean(body.equipment_type)||null,clean(body.brand)||null,
      clean(body.model)||null,clean(body.serial_number)||null,clean(body.reported_issue)||null,num(body.quoted_min),num(body.quoted_max),num(body.approved_price),clean(body.status)||'triage',
      clean(body.diagnosis_notes)||null,clean(body.internal_notes)||null,body.promised_at||null,clean(body.source_message_id)||null]);
    await this.addEvent(companyId,result.rows[0].id,'created',null,clean(body.status)||'triage','OS criada','system');
    return {id:result.rows[0].id};
  }

  async updateOrder(companyId:string,id:string,body:Record<string,unknown>){
    const current=await db.query<{status:string}>(`select status from assist_orders where company_id=$1 and id=$2`,[companyId,id]);
    if(!current.rows[0]) throw new Error('ORDER_NOT_FOUND');
    const result=await db.query(`update assist_orders set
      probable_service_id=coalesce($3,probable_service_id),customer_name=coalesce($4,customer_name),equipment_type=coalesce($5,equipment_type),brand=coalesce($6,brand),
      model=coalesce($7,model),serial_number=coalesce($8,serial_number),reported_issue=coalesce($9,reported_issue),quoted_min=coalesce($10,quoted_min),quoted_max=coalesce($11,quoted_max),
      approved_price=coalesce($12,approved_price),status=coalesce($13,status),diagnosis_notes=coalesce($14,diagnosis_notes),internal_notes=coalesce($15,internal_notes),promised_at=coalesce($16,promised_at),updated_at=now()
      where company_id=$1 and id=$2 returning id::text,status`,[companyId,id,body.probable_service_id||null,body.customer_name||null,body.equipment_type||null,body.brand||null,body.model||null,
      body.serial_number||null,body.reported_issue||null,num(body.quoted_min),num(body.quoted_max),num(body.approved_price),body.status||null,body.diagnosis_notes||null,body.internal_notes||null,body.promised_at||null]);
    if(body.status&&body.status!==current.rows[0].status) await this.addEvent(companyId,id,'status_changed',current.rows[0].status,String(body.status),clean(body.note)||null,'panel');
    return result.rows[0];
  }

  async settings(companyId:string){
    return (await db.query(`select business_name,address,instagram,opening_hours,diagnosis_fee::float,diagnosis_waived_if_approved,pickup_enabled,default_warranty_days
      from assist_settings where company_id=$1`,[companyId])).rows[0]??{};
  }

  async saveSettings(companyId:string,body:Record<string,unknown>){
    await db.query(`insert into assist_settings(company_id,business_name,address,instagram,opening_hours,diagnosis_fee,diagnosis_waived_if_approved,pickup_enabled,default_warranty_days,updated_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) on conflict(company_id) do update set business_name=excluded.business_name,address=excluded.address,instagram=excluded.instagram,
      opening_hours=excluded.opening_hours,diagnosis_fee=excluded.diagnosis_fee,diagnosis_waived_if_approved=excluded.diagnosis_waived_if_approved,pickup_enabled=excluded.pickup_enabled,
      default_warranty_days=excluded.default_warranty_days,updated_at=now()`,[companyId,clean(body.business_name)||null,clean(body.address)||null,clean(body.instagram)||null,clean(body.opening_hours)||null,
      num(body.diagnosis_fee)??0,body.diagnosis_waived_if_approved!==false,Boolean(body.pickup_enabled),Number(body.default_warranty_days)||90]);
    return this.settings(companyId);
  }

  async findCandidates(companyId:string,input:{equipment?:string;brand?:string;model?:string;problem?:string}){
    const tokens=[input.equipment,input.brand,input.model,input.problem].map(clean).filter(Boolean).join(' ');
    if(!tokens) return [];
    return (await db.query(`select id::text,category,equipment_type,brand,model_pattern,name,description,pricing_mode,price_min::float,price_max::float,requires_diagnosis
      from assist_services where company_id=$1 and active=true and (
        lower($2) like '%'||lower(equipment_type)||'%' or lower($2) like '%'||lower(coalesce(brand,''))||'%' or lower($2) like '%'||lower(name)||'%'
        or lower(name) like '%'||lower($2)||'%') order by case when pricing_mode='exact' then 0 when pricing_mode='range' then 1 else 2 end,name limit 8`,[companyId,tokens])).rows;
  }

  async upsertConversationOrder(input:{companyId:string;phone:string;name:string;messageId:string;channel?:string;equipment?:string;brand?:string;model?:string;problem?:string;service?:any}){
    const phone=clean(input.phone).replace(/\D/g,'');
    const active=await db.query<{id:string}>(`select id::text from assist_orders where company_id=$1 and customer_phone=$2 and status in ('triage','quoted','awaiting_approval') order by updated_at desc limit 1`,[input.companyId,phone]);
    const service=input.service;
    const patch:any={customer_name:input.name||'Cliente',equipment_type:input.equipment||null,brand:input.brand||null,model:input.model||null,reported_issue:input.problem||null,
      probable_service_id:service?.id||null,quoted_min:service?.price_min??null,quoted_max:service?.price_max??service?.price_min??null,
      status:service&&service.pricing_mode!=='diagnosis'&&!service.requires_diagnosis?'quoted':'triage'};
    if(active.rows[0]) { await this.updateOrder(input.companyId,active.rows[0].id,patch); return {id:active.rows[0].id,...patch}; }
    return this.createOrder(input.companyId,{...patch,customer_phone:phone,channel:input.channel||'whatsapp',source_message_id:input.messageId});
  }

  private async addEvent(companyId:string,orderId:string,eventType:string,fromStatus:string|null,toStatus:string|null,note:string|null,actor:string){
    await db.query(`insert into assist_order_events(company_id,order_id,event_type,from_status,to_status,note,actor) values($1,$2,$3,$4,$5,$6,$7)`,[companyId,orderId,eventType,fromStatus,toStatus,note,actor]);
  }
}

export const assistService=new AssistService();
