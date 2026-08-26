import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveTenantContext, tenantErrorStatus } from '../../platform/security/tenant-context.js';
import { assistService } from './service.js';
import { assistImportService } from './ai/import.service.js';

type Method='GET'|'POST'|'PUT'|'PATCH';
function fail(reply:FastifyReply,error:unknown){
  const message=error instanceof Error?error.message:String(error);
  const tenant=tenantErrorStatus(error);
  const status=tenant!==500?tenant:/NOT_FOUND/.test(message)?404:/CONFLICT/.test(message)?409:/REQUIRED|INVALID|AI_NOT_CONFIGURED/.test(message)?400:500;
  return reply.code(status).send({error:message});
}
function route(app:FastifyInstance,method:Method,url:string,handler:(req:FastifyRequest,reply:FastifyReply,companyId:string)=>Promise<unknown>){
  app.route({method,url,handler:async(req,reply)=>{try{const tenant=await resolveTenantContext(req);return await handler(req,reply,tenant.companyId);}catch(error){return fail(reply,error);}}});
}

export async function registerAssistRoutes(app:FastifyInstance){
  route(app,'GET','/internal/verticals/assist/overview',async(_r,reply,id)=>reply.send({data:await assistService.overview(id)}));
  route(app,'GET','/internal/verticals/assist/services',async(_r,reply,id)=>reply.send({data:await assistService.services(id)}));
  route(app,'POST','/internal/verticals/assist/services',async(r,reply,id)=>reply.send({data:await assistService.saveService(id,(r.body??{}) as any)}));
  route(app,'PUT','/internal/verticals/assist/services/:id',async(r,reply,cid)=>reply.send({data:await assistService.saveService(cid,(r.body??{}) as any,(r.params as any).id)}));
  route(app,'GET','/internal/verticals/assist/orders',async(r,reply,id)=>reply.send({data:await assistService.orders(id,(r.query as any)?.status)}));
  route(app,'POST','/internal/verticals/assist/orders',async(r,reply,id)=>reply.send({data:await assistService.createOrder(id,(r.body??{}) as any)}));
  route(app,'PATCH','/internal/verticals/assist/orders/:id',async(r,reply,cid)=>reply.send({data:await assistService.updateOrder(cid,(r.params as any).id,(r.body??{}) as any)}));
  route(app,'GET','/internal/verticals/assist/settings',async(_r,reply,id)=>reply.send({data:await assistService.settings(id)}));
  route(app,'PUT','/internal/verticals/assist/settings',async(r,reply,id)=>reply.send({data:await assistService.saveSettings(id,(r.body??{}) as any)}));

  route(app,'POST','/internal/verticals/assist/import/preview',async(r,reply,_id)=>{
    const result=await assistImportService.parse(String((r.body as any)?.text??''));
    return reply.send({data:result});
  });
  route(app,'POST','/internal/verticals/assist/import/commit',async(r,reply,id)=>{
    const rows=Array.isArray((r.body as any)?.services)?(r.body as any).services:[];
    if(!rows.length)throw new Error('IMPORT_SERVICES_REQUIRED');
    const saved=[];
    for(const item of rows)saved.push(await assistService.saveService(id,item));
    return reply.send({data:{saved:saved.length,services:saved}});
  });
}
