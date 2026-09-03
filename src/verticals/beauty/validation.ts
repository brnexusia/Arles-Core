import { z } from 'zod';

export const uuidSchema = z.string().uuid();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(`${value}T12:00:00Z`)), 'invalid date');
const dateTime = z.string().min(16).max(40).refine(value => !Number.isNaN(Date.parse(value)), 'invalid datetime');
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);
const phone = z.string().min(10).max(32).refine(value => {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}, 'invalid phone');

export const serviceInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional().default(''),
  duration_minutes: z.coerce.number().int().min(5).max(720),
  price: z.coerce.number().min(0).max(100000),
  active: z.boolean().optional().default(true)
}).strip();

const availabilityRowSchema = z.object({
  weekday: z.coerce.number().int().min(0).max(6),
  start_time: time,
  end_time: time,
  slot_interval_minutes: z.coerce.number().int().min(5).max(240)
}).strip().refine(row => row.end_time > row.start_time, { message: 'end_time must be after start_time' });

export const professionalInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  specialty: z.string().trim().max(160).optional().default(''),
  phone: z.string().trim().max(32).optional().default('').refine(value => !value || phone.safeParse(value).success, 'invalid phone'),
  active: z.boolean().optional().default(true),
  service_ids: z.array(uuidSchema).max(100).optional().default([]),
  availability: z.array(availabilityRowSchema).max(14).optional().default([])
}).strip();

export const appointmentCreateSchema = z.object({
  service_id: uuidSchema,
  professional_id: uuidSchema,
  starts_at: dateTime,
  customer_name: z.string().trim().min(1).max(160),
  customer_phone: phone,
  notes: z.string().trim().max(1000).optional().default(''),
  status: z.enum(['scheduled','confirmed']).optional().default('scheduled'),
  source: z.string().trim().max(40).optional().default('panel')
}).strip();

export const publicAppointmentSchema = appointmentCreateSchema.pick({
  service_id: true,
  professional_id: true,
  starts_at: true,
  customer_name: true,
  customer_phone: true,
  notes: true
});

export const appointmentUpdateSchema = z.object({
  service_id: uuidSchema.optional(),
  professional_id: uuidSchema.optional(),
  starts_at: dateTime.optional(),
  notes: z.string().trim().max(1000).optional(),
  status: z.enum(['scheduled','confirmed','completed','canceled','no_show']).optional()
}).strip().refine(value => Object.keys(value).length > 0, 'empty update');

export const settingsInputSchema = z.object({
  business_name: z.string().trim().max(160).optional().default(''),
  address: z.string().trim().max(500).optional().default(''),
  instagram: z.string().trim().max(100).optional().default(''),
  cancellation_policy: z.string().trim().max(2000).optional().default(''),
  booking_notice_minutes: z.coerce.number().int().min(0).max(43200).optional().default(60)
}).strip();

export const availabilityQuerySchema = z.object({
  service_id: uuidSchema,
  professional_id: uuidSchema.optional(),
  date: dateOnly,
  limit: z.coerce.number().int().min(1).max(100).optional()
}).strip();

export const appointmentsQuerySchema = z.object({
  from: dateTime.optional(),
  to: dateTime.optional()
}).strip().refine(value => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), 'invalid range');

export const customersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(200)
}).strip();

export function parseBeautyInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'input'}:${issue.code}`).join(',');
    throw new Error(`INPUT_INVALID:${details}`);
  }
  return parsed.data;
}
