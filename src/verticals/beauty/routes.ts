import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/db.js';
import { resolveTenantContext, tenantErrorStatus } from '../../platform/security/tenant-context.js';
import { beautyService } from './service.js';
import { beautyWhatsAppService } from './whatsapp.service.js';

type Method='GET'|'POST'|'PUT'|'PATCH';
function fail(reply:FastifyReply,error:unknown){
  const message=error instanceof Error?error.message:String(error);
  const tenant=tenantErrorStatus(error);
  const status=tenant!==500?tenant:/BEAUTY_SUBSCRIPTION_REQUIRED/.test(message)?402:/NOT_FOUND/.test(message)?404:/CONFLICT|NOT_AVAILABLE|NOTICE|CAPACITY/.test(message)?409:/REQUIRED|INVALID/.test(message)?400:500;
  return reply.code(status).send({error:message});
}
async function assertPaidBeauty(companyId:string){
  const result=await db.query<{subscription_status:string;access_active:boolean;vertical:string}>(`select
    subscription_status,access_active,coalesce(active_vertical_id,vertical) vertical
    from companies where id=$1 limit 1`,[companyId]);
  const company=result.rows[0];
  if(!company||company.vertical!=='beauty')throw new Error('BEAUTY_COMPANY_NOT_FOUND');
  if(!company.access_active||String(company.subscription_status).toLowerCase()!=='active')throw new Error('BEAUTY_SUBSCRIPTION_REQUIRED');
}
function route(app:FastifyInstance,method:Method,url:string,handler:(req:FastifyRequest,reply:FastifyReply,companyId:string)=>Promise<unknown>){
  app.route({method,url,handler:async(req,reply)=>{try{const tenant=await resolveTenantContext(req);await assertPaidBeauty(tenant.companyId);return await handler(req,reply,tenant.companyId);}catch(error){return fail(reply,error);}}});
}

export async function registerBeautyRoutes(app:FastifyInstance){
  route(app,'GET','/internal/verticals/beauty/overview',async(_r,reply,id)=>reply.send({data:await beautyService.overview(id)}));
  route(app,'GET','/internal/verticals/beauty/services',async(_r,reply,id)=>reply.send({data:await beautyService.services(id)}));
  route(app,'POST','/internal/verticals/beauty/services',async(r,reply,id)=>reply.send({data:await beautyService.saveService(id,(r.body??{}) as any)}));
  route(app,'PUT','/internal/verticals/beauty/services/:id',async(r,reply,cid)=>reply.send({data:await beautyService.saveService(cid,(r.body??{}) as any,(r.params as any).id)}));

  route(app,'GET','/internal/verticals/beauty/professionals',async(_r,reply,id)=>reply.send({data:await beautyService.professionals(id)}));
  route(app,'POST','/internal/verticals/beauty/professionals',async(r,reply,id)=>reply.send({data:await beautyService.saveProfessional(id,(r.body??{}) as any)}));
  route(app,'PUT','/internal/verticals/beauty/professionals/:id',async(r,reply,cid)=>reply.send({data:await beautyService.saveProfessional(cid,(r.body??{}) as any,(r.params as any).id)}));

  route(app,'GET','/internal/verticals/beauty/customers',async(r,reply,id)=>{const q=r.query as any;return reply.send({data:await beautyService.customers(id,Number(q.limit)||200)});});
  route(app,'GET','/internal/verticals/beauty/availability',async(r,reply,id)=>{const q=r.query as any;return reply.send({data:await beautyService.availableSlots(id,{serviceId:String(q.service_id||''),date:String(q.date||''),professionalId:q.professional_id?String(q.professional_id):undefined,limit:Number(q.limit)||30})});});

  route(app,'GET','/internal/verticals/beauty/appointments',async(r,reply,id)=>{const q=r.query as any;return reply.send({data:await beautyService.appointments(id,q.from,q.to)});});
  route(app,'POST','/internal/verticals/beauty/appointments',async(r,reply,id)=>reply.send({data:await beautyService.createAppointment(id,(r.body??{}) as any)}));
  route(app,'PATCH','/internal/verticals/beauty/appointments/:id',async(r,reply,cid)=>reply.send({data:await beautyService.updateAppointment(cid,(r.params as any).id,(r.body??{}) as any)}));

  route(app,'GET','/internal/verticals/beauty/settings',async(_r,reply,id)=>reply.send({data:await beautyService.settings(id)}));
  route(app,'PUT','/internal/verticals/beauty/settings',async(r,reply,id)=>reply.send({data:await beautyService.saveSettings(id,(r.body??{}) as any)}));

  route(app,'GET','/internal/verticals/beauty/whatsapp/status',async(_r,reply,id)=>reply.send({data:await beautyWhatsAppService.status(id)}));
  route(app,'POST','/internal/verticals/beauty/whatsapp/connect',async(_r,reply,id)=>reply.send({data:await beautyWhatsAppService.connect(id)}));
  route(app,'POST','/internal/verticals/beauty/whatsapp/disconnect',async(_r,reply,id)=>reply.send({data:await beautyWhatsAppService.disconnect(id)}));
  route(app,'GET','/internal/verticals/beauty/whatsapp/clusters',async(_r,reply,_id)=>reply.send({data:await beautyWhatsAppService.clusterHealth()}));
}
