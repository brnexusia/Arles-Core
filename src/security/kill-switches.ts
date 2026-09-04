export type BeautyFeature = 'global' | 'ai' | 'billing' | 'whatsapp' | 'public_booking';

function enabled(name: string, fallback = true): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no', 'disabled'].includes(value);
}

export function beautyFeatureEnabled(feature: BeautyFeature): boolean {
  if (!enabled('BEAUTY_ENABLED', true)) return false;
  switch (feature) {
    case 'global': return true;
    case 'ai': return enabled('BEAUTY_AI_ENABLED', true);
    case 'billing': return enabled('BEAUTY_NEW_BILLING_ENABLED', true);
    case 'whatsapp': return enabled('BEAUTY_WHATSAPP_ENABLED', true);
    case 'public_booking': return enabled('BEAUTY_PUBLIC_BOOKING_ENABLED', true);
  }
}

export function assertBeautyFeature(feature: BeautyFeature): void {
  if (beautyFeatureEnabled(feature)) return;
  const code: Record<BeautyFeature, string> = {
    global: 'BEAUTY_DISABLED',
    ai: 'BEAUTY_AI_DISABLED',
    billing: 'BEAUTY_NEW_BILLING_DISABLED',
    whatsapp: 'BEAUTY_WHATSAPP_DISABLED',
    public_booking: 'BEAUTY_PUBLIC_BOOKING_DISABLED'
  };
  throw new Error(code[feature]);
}
