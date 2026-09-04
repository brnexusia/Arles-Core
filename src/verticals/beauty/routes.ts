import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/db.js';
import { enforceIpLimit, enforceRateLimit } from '../../security/rate-limit.js';
import { recordAuditEvent } from '../../security/audit.js';
import { assertBeautyFeature } from '../../security/kill-switches.js';
import { resolveTenantContext, tenantErrorStatus } from '../../platform/security/tenant-context.js';
import { beautyPublicBookingService } from './public-booking.service.js';
import { assertProfessionalCapacity, assertServiceCapacity, reserveBookingQuota } from './quota.js';
import { beautyService } from './service.js';
import { beautyWhatsAppService } from './whatsapp.service.js';
import {
  appointmentCreateSchema,
  appointmentUpdateSchema,
  appointmentsQuerySchema,
  availabilityQuerySchema,
  customersQuerySchema,
  parseBeautyInput,
  professionalInputSchema,
  publicAppointmentSchema,
  serviceInputSchema,
  settingsInputSchema,
  uuidSchema
} from './validation.js';

type Method='GET'|'POST'|'PUT'|'PATCH';
function fail(reply:FastifyReply,error:unknown){
  const message=error instanceof Error?error.message:String(error);
  const tenant=tenantErrorStatus(error);
  const status=tenant!==500?tenant:/^BEAUTY_(DISABLED|PUBLIC_BOOKING_DISABLED|WHATSAPP_DISABLED)$/.test(message)?503:message==='RATE_LIMITED'||/QUOTA_REACHED/.test(message)?429:/BEAUTY_SUBSCRIPTION_REQUIRED/.test(message)?402:/NOT_FOUND|BOOKING_LINK/.test(message)?404:/CONFLICT|NOT_AVAILABLE|NOTICE|CAPACITY/.test(message)?409:/REQUIRED|INVALID/.test(message)?400:500;
  return reply.code(status).send({error:message==='RATE_LIMITED'?'RATE_LIMITED':message});
}
async function assertPaidBeauty(companyId:string){
  assertBeautyFeature('global');
  const result=await db.query<{subscription_status:string;access_active:boolean;vertical:string}>(`select
    subscription_status,access_active,coalesce(active_vertical_id,vertical) vertical
    from companies where id=$1 limit 1`,[companyId]);
  const company=result.rows[0];
  if(!company||company.vertical!=='beauty')throw new Error('BEAUTY_COMPANY_NOT_FOUND');
  if(!company.access_active||String(company.subscription_status).toLowerCase()!=='active')throw new Error('BEAUTY_SUBSCRIPTION_REQUIRED');
}
async function tenantLimit(reply:FastifyReply,companyId:string,method:Method,url:string){
  const expensive=/whatsapp\/connect/.test(url);
  const write=method!=='GET';
  const limit=expensive?6:write?90:360;
  const windowSeconds=expensive?60*60:60;
  await enforceRateLimit({scope:`beauty:tenant:${method}:${url}`,limit,windowSeconds,identity:companyId},reply);
}
function auditAction(method:Method,url:string){
  return `beauty.${method.toLowerCase()}.${url.replace('/internal/verticals/beauty/','').replace(/\//g,'.').replace(':id','item')}`;
}
function route(app:FastifyInstance,method:Method,url:string,handler:(req:FastifyRequest,reply:FastifyReply,companyId:string)=>Promise<unknown>){
  app.route({method,url,bodyLimit:method==='GET'?undefined:128*1024,handler:async(req,reply)=>{
    try{
      const tenant=await resolveTenantContext(req);
      await assertPaidBeauty(tenant.companyId);
      await tenantLimit(reply,tenant.companyId,method,url);
      const result=await handler(req,reply,tenant.companyId);
      if(method!=='GET'){
        await recordAuditEvent({
          companyId:tenant.companyId,
          actorUserId:tenant.user?.id||null,
          action:auditAction(method,url),
          targetType:url.includes('appointments')?'appointment':url.includes('professionals')?'professional':url.includes('services')?'service':url.includes('whatsapp')?'whatsapp':'beauty_setting',
          targetId:String((req.params as any)?.id||'')||null,
          requestId:req.id,
          source:tenant.source
        }).catch(error=>req.log.error({err:error},'Falha registrando auditoria Beauty'));
      }
      return result;
    }catch(error){return fail(reply,error);}
  }});
}
function routeId(req:FastifyRequest){return parseBeautyInput(uuidSchema,String((req.params as any).id||''));}
function assertPublicBooking(){assertBeautyFeature('global');assertBeautyFeature('public_booking');}

export async function registerBeautyRoutes(app:FastifyInstance){
  app.get('/public/beauty/:slug',async(req,reply)=>{try{assertPublicBooking();await enforceIpLimit(req,reply,'beauty:public:info',120,60);return reply.send({data:await beautyPublicBookingService.info(String((req.params as any).slug||''))});}catch(error){return fail(reply,error);}});
  app.get('/public/beauty/:slug/availability',async(req,reply)=>{try{assertPublicBooking();await enforceIpLimit(req,reply,'beauty:public:availability',120,60);const q=parseBeautyInput(availabilityQuerySchema,req.query??{});return reply.send({data:await beautyPublicBookingService.availability(String((req.params as any).slug||''),{serviceId:q.service_id,date:q.date})});}catch(error){return fail(reply,error);}});
  app.post('/public/beauty/:slug/appointments',{bodyLimit:32*1024},async(req,reply)=>{try{assertPublicBooking();await enforceIpLimit(req,reply,'beauty:public:book',20,60);const body=parseBeautyInput(publicAppointmentSchema,req.body??{});return reply.send({data:await beautyPublicBookingService.book(String((req.params as any).slug||''),body)});}catch(error){return fail(reply,error);}});

  route(app,'GET','/internal/verticals/beauty/overview',async(_r,reply,id)=>reply.send({data:await beautyService.overview(id)}));
  route(app,'GET','/internal/verticals/beauty/services',async(_r,reply,id)=>reply.send({data:await beautyService.services(id)}));
  route(app,'POST','/internal/verticals/beauty/services',async(r,reply,id)=>{await assertServiceCapacity(id);return reply.send({data:await beautyService.saveService(id,parseBeautyInput(serviceInputSchema,r.body??{}))});});
  route(app,'PUT','/internal/verticals/beauty/services/:id',async(r,reply,cid)=>reply.send({data:await beautyService.saveService(cid,parseBeautyInput(serviceInputSchema,r.body??{}),routeId(r))}));

  route(app,'GET','/internal/verticals/beauty/professionals',async(_r,reply,id)=>reply.send({data:await beautyService.professionals(id)}));
  route(app,'POST','/internal/verticals/beauty/professionals',async(r,reply,id)=>{await assertProfessionalCapacity(id);return reply.send({data:await beautyService.saveProfessional(id,parseBeautyInput(professionalInputSchema,r.body??{}))});});
  route(app,'PUT','/internal/verticals/beauty/professionals/:id',async(r,reply,cid)=>reply.send({data:await beautyService.saveProfessional(cid,parseBeautyInput(professionalInputSchema,r.body??{}),routeId(r))}));

  route(app,'GET','/internal/verticals/beauty/customers',async(r,reply,id)=>{const q=parseBeautyInput(customersQuerySchema,r.query??{});return reply.send({data:await beautyService.customers(id,q.limit)});});
  route(app,'GET','/internal/verticals/beauty/availability',async(r,reply,id)=>{const q=parseBeautyInput(availabilityQuerySchema,r.query??{});return reply.send({data:await beautyService.availableSlots(id,{serviceId:q.service_id,date:q.date,professionalId:q.professional_id,limit:q.limit})});});

  route(app,'GET','/internal/verticals/beauty/appointments',async(r,reply,id)=>{const q=parseBeautyInput(appointmentsQuerySchema,r.query??{});return reply.send({data:await beautyService.appointments(id,q.from,q.to)});});
  route(app,'POST','/internal/verticals/beauty/appointments',async(r,reply,id)=>{
    const release=await reserveBookingQuota(id);
    try{return reply.send({data:await beautyService.createAppointment(id,parseBeautyInput(appointmentCreateSchema,r.body??{}))});}
    catch(error){await release();throw error;}
  });
  route(app,'PATCH','/internal/verticals/beauty/appointments/:id',async(r,reply,cid)=>reply.send({data:await beautyService.updateAppointment(cid,routeId(r),parseBeautyInput(appointmentUpdateSchema,r.body??{}))}));

  route(app,'GET','/internal/verticals/beauty/settings',async(_r,reply,id)=>reply.send({data:await beautyService.settings(id)}));
  route(app,'PUT','/internal/verticals/beauty/settings',async(r,reply,id)=>reply.send({data:await beautyService.saveSettings(id,parseBeautyInput(settingsInputSchema,r.body??{}))}));

  route(app,'GET','/internal/verticals/beauty/whatsapp/status',async(_r,reply,id)=>reply.send({data:await beautyWhatsAppService.status(id)}));
  route(app,'POST','/internal/verticals/beauty/whatsapp/connect',async(_r,reply,id)=>{assertBeautyFeature('whatsapp');return reply.send({data:await beautyWhatsAppService.connect(id)});});
  route(app,'POST','/internal/verticals/beauty/whatsapp/disconnect',async(_r,reply,id)=>{assertBeautyFeature('whatsapp');return reply.send({data:await beautyWhatsAppService.disconnect(id)});});
  route(app,'GET','/internal/verticals/beauty/whatsapp/clusters',async(_r,reply,_id)=>reply.send({data:await beautyWhatsAppService.clusterHealth()}));
}
