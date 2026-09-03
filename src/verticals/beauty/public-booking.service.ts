import { db } from '../../infrastructure/db.js';
import { beautyService } from './service.js';

function clean(value: unknown): string { return String(value ?? '').trim(); }

export class BeautyPublicBookingService {
  private async company(slugInput: string) {
    const slug = clean(slugInput).toLowerCase();
    if (!/^[a-z0-9-]{3,80}$/.test(slug)) throw new Error('BOOKING_LINK_NOT_FOUND');
    const result = await db.query<any>(`select
        c.id::text,c.name,c.slug,c.timezone,c.subscription_status,c.access_active,
        bs.business_name,bs.address,bs.instagram
      from companies c
      left join beauty_settings bs on bs.company_id=c.id
      where c.slug=$1 and coalesce(c.active_vertical_id,c.vertical)='beauty'
      limit 1`, [slug]);
    const company = result.rows[0];
    if (!company || !company.access_active || String(company.subscription_status).toLowerCase() !== 'active') {
      throw new Error('BOOKING_LINK_NOT_FOUND');
    }
    return company;
  }

  async info(slug: string) {
    const company = await this.company(slug);
    const services = await beautyService.services(company.id);
    return {
      slug: company.slug,
      business_name: company.business_name || company.name,
      address: company.address || null,
      instagram: company.instagram || null,
      timezone: company.timezone,
      services: services.filter((service: any) => service.active).map((service: any) => ({
        id: service.id,
        name: service.name,
        description: service.description || null,
        duration_minutes: service.duration_minutes,
        price: Number(service.price)
      }))
    };
  }

  async availability(slug: string, input: { serviceId: string; date: string }) {
    const company = await this.company(slug);
    const slots = await beautyService.availableSlots(company.id, {
      serviceId: input.serviceId,
      date: input.date,
      limit: 20
    });
    return slots.map((slot: any) => ({
      professional_id: slot.professional_id,
      professional_name: slot.professional_name,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at
    }));
  }

  async book(slug: string, body: Record<string, unknown>) {
    const company = await this.company(slug);
    return beautyService.createAppointment(company.id, {
      service_id: body.service_id,
      professional_id: body.professional_id,
      starts_at: body.starts_at,
      customer_name: body.customer_name,
      customer_phone: body.customer_phone,
      notes: body.notes,
      source: 'public_booking_link'
    });
  }
}

export const beautyPublicBookingService = new BeautyPublicBookingService();
