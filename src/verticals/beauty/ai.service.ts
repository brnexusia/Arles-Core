import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../infrastructure/db.js';
import type { VerticalContext, VerticalResult } from '../vertical.js';
import { beautyService } from './service.js';

const BeautyPlanSchema = z.object({
  intent: z.enum(['reply','show_services','show_slots','book','list_appointments','cancel','reschedule']),
  reply: z.string(),
  service_id: z.string(),
  professional_id: z.string(),
  date: z.string(),
  slot_index: z.number().int().min(1).max(20).nullable(),
  appointment_index: z.number().int().min(1).max(20).nullable(),
  customer_name: z.string()
});

type BeautyPlan = z.infer<typeof BeautyPlanSchema>;

type OfferedSlot = {
  service_id: string;
  professional_id: string;
  professional_name: string;
  starts_at: string;
  ends_at: string;
};

type BeautyState = {
  last_slots?: OfferedSlot[];
  last_appointments?: Array<{ id: string; service_id: string; professional_id: string; starts_at: string }>;
  pending_action?: 'book' | 'reschedule';
  pending_appointment_id?: string;
};

function brl(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function iso(value: unknown): string {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function localDate(value: unknown, timeZone: string): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date).replace(',', '');
}

function today(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export class BeautyAiService {
  private client: OpenAI | null;

  constructor() {
    this.client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;
  }

  private async loadState(companyId: string, phone: string): Promise<BeautyState> {
    const result = await db.query<{ draft: BeautyState | null }>(`select draft
      from conversation_sessions where company_id=$1 and phone_number=$2 and vertical='beauty' limit 1`, [companyId,phone]);
    return result.rows[0]?.draft ?? {};
  }

  private async saveState(companyId: string, phone: string, state: BeautyState): Promise<void> {
    await db.query(`insert into conversation_sessions(company_id,phone_number,vertical,state,draft,updated_at)
      values($1,$2,'beauty','active',$3::jsonb,now())
      on conflict(company_id,phone_number,vertical) do update set state='active',draft=excluded.draft,updated_at=now()`,
      [companyId,phone,JSON.stringify(state)]);
  }

  private async recentHistory(companyId: string, phone: string) {
    return (await db.query<{direction:string;body:string}>(`select direction,coalesce(body,'') body
      from messages where company_id=$1 and phone_number=$2 order by created_at desc limit 12`, [companyId,phone])).rows.reverse();
  }

  private async plan(context: VerticalContext, state: BeautyState, data: {
    services: any[];
    professionals: any[];
    settings: any;
    appointments: any[];
    history: Array<{direction:string;body:string}>;
  }): Promise<BeautyPlan | null> {
    if (!this.client) return null;

    const serviceContext = data.services.filter(item => item.active).map(item => ({
      id: item.id,
      name: item.name,
      description: item.description || '',
      duration_minutes: item.duration_minutes,
      price: Number(item.price)
    }));
    const professionalContext = data.professionals.filter(item => item.active).map(item => ({
      id: item.id,
      name: item.name,
      specialty: item.specialty || '',
      service_ids: item.service_ids || []
    }));
    const appointmentContext = data.appointments.map((item, index) => ({
      index: index + 1,
      id: item.id,
      service_id: item.service_id,
      service_name: item.service_name,
      professional_id: item.professional_id,
      professional_name: item.professional_name,
      starts_at: iso(item.starts_at),
      status: item.status
    }));
    const offeredSlots = (state.last_slots || []).map((item, index) => ({
      index: index + 1,
      service_id: item.service_id,
      professional_id: item.professional_id,
      professional_name: item.professional_name,
      starts_at: item.starts_at
    }));

    try {
      const response = await this.client.responses.parse({
        model: env.beautyOpenaiModel,
        input: [
          {
            role: 'system',
            content: [
              'Você é a camada semântica do Arles Beauty para atendimento de agenda via WhatsApp.',
              'Converse em português brasileiro de forma curta, natural e simpática. Não use texto robótico nem faça interrogatório.',
              'Seu papel é INTERPRETAR a intenção. O servidor executa agenda, disponibilidade e alterações.',
              'NUNCA invente horário, preço, serviço, profissional, política ou disponibilidade.',
              'Serviços/preços só podem vir de SERVICOS_REAIS. Profissionais só podem vir de PROFISSIONAIS_REAIS.',
              'Horários só podem ser prometidos se já estiverem em SLOTS_OFERECIDOS. Caso o cliente peça disponibilidade para um dia, use intent=show_slots.',
              'Para reservar um dos horários já oferecidos, use intent=book e slot_index com o número do slot. Não escreva que marcou antes do servidor confirmar.',
              'Para consultar agendamentos do cliente use intent=list_appointments. Para cancelar, use intent=cancel e appointment_index somente de AGENDAMENTOS_DO_CLIENTE.',
              'Para reagendar: se ainda precisa mostrar horários, use intent=reschedule, appointment_index e date. Se o cliente escolheu um slot já oferecido para reagendamento, use intent=reschedule e slot_index.',
              'Quando faltar serviço ou data para procurar horários, intent=reply e faça apenas a pergunta necessária.',
              'Se o cliente só quer conhecer serviços/preços, use intent=show_services. O servidor monta a lista real.',
              'Perguntas de endereço, Instagram, regras ou informações do estabelecimento podem ser respondidas em reply SOMENTE com CONFIGURACAO_REAL.',
              'Se a informação não estiver na configuração, diga que não tem essa informação agora; não improvise.',
              'service_id/professional_id devem ser IDs exatos do contexto ou string vazia. Nunca fabrique UUID.',
              'date deve ser YYYY-MM-DD e deve refletir a data local indicada. Resolva hoje/amanhã usando DATA_LOCAL_ATUAL.',
              'reply é a resposta natural para intent=reply. Nos demais intents pode ser curto ou vazio porque o servidor responderá com dados reais.',
              `DATA_LOCAL_ATUAL=${today(context.company.timezone)}`,
              `CONFIGURACAO_REAL=${JSON.stringify(data.settings || {})}`,
              `SERVICOS_REAIS=${JSON.stringify(serviceContext)}`,
              `PROFISSIONAIS_REAIS=${JSON.stringify(professionalContext)}`,
              `AGENDAMENTOS_DO_CLIENTE=${JSON.stringify(appointmentContext)}`,
              `SLOTS_OFERECIDOS=${JSON.stringify(offeredSlots)}`,
              `ESTADO_CURTO=${JSON.stringify({ pending_action: state.pending_action || '', pending_appointment_id: state.pending_appointment_id || '' })}`,
              `HISTORICO_RECENTE=${JSON.stringify(data.history.map(item => ({ who: item.direction === 'in' ? 'cliente' : 'arles', text: item.body })).slice(-10))}`
            ].join('\n')
          },
          { role: 'user', content: context.combinedText }
        ],
        text: { format: zodTextFormat(BeautyPlanSchema, 'beauty_plan') }
      });
      return response.output_parsed ?? null;
    } catch (error) {
      console.error('[BeautyAI] falha interpretando conversa:', error);
      return null;
    }
  }

  private serviceText(services: any[]): string {
    const active = services.filter(item => item.active);
    if (!active.length) return 'Nossa lista de serviços ainda está sendo configurada.';
    return `Claro 😊 Hoje temos:\n\n${active.map(item => `• ${item.name} — ${brl(Number(item.price))} · ${item.duration_minutes} min`).join('\n')}\n\nQual você gostaria de fazer?`;
  }

  private slotsText(slots: OfferedSlot[], timeZone: string): string {
    if (!slots.length) return 'Não encontrei horário livre nesse dia. Quer tentar outra data?';
    return `Tenho estes horários livres:\n\n${slots.map((slot,index) => `${index + 1}. ${localDate(slot.starts_at,timeZone)} — ${slot.professional_name}`).join('\n')}\n\nQual opção você prefere?`;
  }

  private appointmentsText(appointments: any[], timeZone: string): string {
    if (!appointments.length) return 'Não encontrei nenhum agendamento futuro para este número.';
    return `Encontrei estes agendamentos:\n\n${appointments.map((item,index) => `${index + 1}. ${item.service_name} — ${localDate(item.starts_at,timeZone)} com ${item.professional_name}`).join('\n')}\n\nSe quiser, posso reagendar ou cancelar um deles.`;
  }

  private appointmentFromState(state: BeautyState, appointments: any[], index: number | null) {
    if (index && state.last_appointments?.[index - 1]) {
      const id = state.last_appointments[index - 1]!.id;
      return appointments.find(item => item.id === id) || null;
    }
    if (appointments.length === 1) return appointments[0];
    return null;
  }

  private async verifiedCustomerAppointment(companyId: string, phone: string, id: string) {
    const rows = await beautyService.findCustomerAppointments(companyId, phone);
    return rows.find((item: any) => item.id === id) || null;
  }

  async handle(context: VerticalContext): Promise<VerticalResult | null> {
    if (!this.client) return null;

    const [services, professionals, settings, appointments, state, history] = await Promise.all([
      beautyService.services(context.company.id),
      beautyService.professionals(context.company.id),
      beautyService.settings(context.company.id),
      beautyService.findCustomerAppointments(context.company.id, context.message.phone),
      this.loadState(context.company.id, context.message.phone),
      this.recentHistory(context.company.id, context.message.phone)
    ]);

    if (!services.some((item: any) => item.active)) {
      return { actions: [{ type: 'text', text: 'Oi! A agenda ainda está sendo configurada. Tente novamente um pouco mais tarde, por favor.' }] };
    }

    const plan = await this.plan(context, state, { services, professionals, settings, appointments, history });
    if (!plan) return null;

    if (plan.intent === 'show_services') {
      return { actions: [{ type: 'text', text: this.serviceText(services) }] };
    }

    if (plan.intent === 'list_appointments') {
      const nextState: BeautyState = {
        ...state,
        last_appointments: appointments.map((item: any) => ({
          id: item.id,
          service_id: item.service_id,
          professional_id: item.professional_id,
          starts_at: iso(item.starts_at)
        }))
      };
      await this.saveState(context.company.id, context.message.phone, nextState);
      return { actions: [{ type: 'text', text: this.appointmentsText(appointments, context.company.timezone) }] };
    }

    if (plan.intent === 'show_slots') {
      const service = services.find((item: any) => item.id === plan.service_id && item.active);
      if (!service) return { actions: [{ type: 'text', text: 'Qual serviço você quer fazer? Posso te mostrar as opções disponíveis.' }] };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.date)) return { actions: [{ type: 'text', text: 'Para qual dia você gostaria de agendar?' }] };
      const slots = await beautyService.availableSlots(context.company.id, {
        serviceId: service.id,
        date: plan.date,
        professionalId: professionals.some((item: any) => item.id === plan.professional_id) ? plan.professional_id : undefined,
        limit: 8
      });
      const offered: OfferedSlot[] = slots.map((slot: any) => ({
        service_id: service.id,
        professional_id: slot.professional_id,
        professional_name: slot.professional_name,
        starts_at: iso(slot.starts_at),
        ends_at: iso(slot.ends_at)
      }));
      await this.saveState(context.company.id, context.message.phone, {
        ...state,
        last_slots: offered,
        pending_action: 'book',
        pending_appointment_id: undefined
      });
      return { actions: [{ type: 'text', text: this.slotsText(offered, context.company.timezone) }] };
    }

    if (plan.intent === 'book') {
      const slot = plan.slot_index ? state.last_slots?.[plan.slot_index - 1] : undefined;
      if (!slot || state.pending_action !== 'book') {
        return { actions: [{ type: 'text', text: 'Antes de marcar, vou conferir os horários livres. Qual serviço e qual dia você prefere?' }] };
      }
      const service = services.find((item: any) => item.id === slot.service_id && item.active);
      if (!service) return { actions: [{ type: 'text', text: 'Esse serviço não está mais disponível. Quer ver os serviços atuais?' }] };
      try {
        await beautyService.createAppointment(context.company.id, {
          service_id: slot.service_id,
          professional_id: slot.professional_id,
          starts_at: slot.starts_at,
          customer_name: plan.customer_name.trim() || context.message.pushName || 'Cliente',
          customer_phone: context.message.phone,
          source: 'whatsapp_ai'
        });
        await this.saveState(context.company.id, context.message.phone, {});
        return { actions: [{ type: 'text', text: `Pronto! Seu ${service.name} ficou agendado para ${localDate(slot.starts_at,context.company.timezone)} com ${slot.professional_name}. ✅` }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/CONFLICT|NOT_AVAILABLE/.test(message)) {
          await this.saveState(context.company.id, context.message.phone, {});
          return { actions: [{ type: 'text', text: 'Esse horário acabou de ficar indisponível. Posso conferir os próximos horários livres para você.' }] };
        }
        throw error;
      }
    }

    if (plan.intent === 'cancel') {
      const selected = this.appointmentFromState(state, appointments, plan.appointment_index);
      if (!selected) {
        const nextState: BeautyState = { ...state, last_appointments: appointments.map((item: any) => ({ id:item.id, service_id:item.service_id, professional_id:item.professional_id, starts_at:iso(item.starts_at) })) };
        await this.saveState(context.company.id, context.message.phone, nextState);
        return { actions: [{ type: 'text', text: this.appointmentsText(appointments, context.company.timezone) }] };
      }
      const verified = await this.verifiedCustomerAppointment(context.company.id, context.message.phone, selected.id);
      if (!verified) return { actions: [{ type: 'text', text: 'Não encontrei esse agendamento ativo para este número.' }] };
      await beautyService.updateAppointment(context.company.id, selected.id, { status: 'canceled' });
      await this.saveState(context.company.id, context.message.phone, {});
      return { actions: [{ type: 'text', text: `Certo, cancelei o agendamento de ${verified.service_name} de ${localDate(verified.starts_at,context.company.timezone)}. ✅` }] };
    }

    if (plan.intent === 'reschedule') {
      if (plan.slot_index && state.pending_action === 'reschedule' && state.pending_appointment_id) {
        const slot = state.last_slots?.[plan.slot_index - 1];
        const verified = await this.verifiedCustomerAppointment(context.company.id, context.message.phone, state.pending_appointment_id);
        if (!slot || !verified || slot.service_id !== verified.service_id) {
          await this.saveState(context.company.id, context.message.phone, {});
          return { actions: [{ type: 'text', text: 'Preciso conferir os horários novamente. Para qual dia você quer reagendar?' }] };
        }
        try {
          await beautyService.updateAppointment(context.company.id, verified.id, {
            service_id: verified.service_id,
            professional_id: slot.professional_id,
            starts_at: slot.starts_at
          });
          await this.saveState(context.company.id, context.message.phone, {});
          return { actions: [{ type: 'text', text: `Feito! Reagendei para ${localDate(slot.starts_at,context.company.timezone)} com ${slot.professional_name}. ✅` }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/CONFLICT|NOT_AVAILABLE/.test(message)) {
            await this.saveState(context.company.id, context.message.phone, {});
            return { actions: [{ type: 'text', text: 'Esse horário acabou de ficar indisponível. Quer que eu procure outro?' }] };
          }
          throw error;
        }
      }

      const selected = this.appointmentFromState(state, appointments, plan.appointment_index);
      if (!selected) {
        const nextState: BeautyState = { ...state, last_appointments: appointments.map((item: any) => ({ id:item.id, service_id:item.service_id, professional_id:item.professional_id, starts_at:iso(item.starts_at) })) };
        await this.saveState(context.company.id, context.message.phone, nextState);
        return { actions: [{ type: 'text', text: this.appointmentsText(appointments, context.company.timezone) }] };
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.date)) {
        return { actions: [{ type: 'text', text: 'Para qual dia você quer reagendar?' }] };
      }
      const verified = await this.verifiedCustomerAppointment(context.company.id, context.message.phone, selected.id);
      if (!verified) return { actions: [{ type: 'text', text: 'Não encontrei esse agendamento ativo para este número.' }] };
      const slots = await beautyService.availableSlots(context.company.id, {
        serviceId: verified.service_id,
        date: plan.date,
        professionalId: verified.professional_id,
        limit: 8
      });
      const offered: OfferedSlot[] = slots.map((slot: any) => ({
        service_id: verified.service_id,
        professional_id: slot.professional_id,
        professional_name: slot.professional_name,
        starts_at: iso(slot.starts_at),
        ends_at: iso(slot.ends_at)
      }));
      await this.saveState(context.company.id, context.message.phone, {
        ...state,
        last_slots: offered,
        pending_action: 'reschedule',
        pending_appointment_id: verified.id
      });
      return { actions: [{ type: 'text', text: this.slotsText(offered, context.company.timezone) }] };
    }

    return { actions: [{ type: 'text', text: plan.reply.trim() || 'Como posso te ajudar com seu agendamento?' }] };
  }
}

export const beautyAiService = new BeautyAiService();
