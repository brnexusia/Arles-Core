function numberSetting(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const deliveryConfig = {
  recentConfirmedTtlSeconds: numberSetting('DELIVERY_RECENT_CONFIRMED_TTL_SECONDS', 86_400),
  reviewTtlSeconds: numberSetting('DELIVERY_REVIEW_TTL_SECONDS', 604_800),
  pixProofMaxAgeHours: numberSetting('DELIVERY_PIX_PROOF_MAX_AGE_HOURS', 8)
};
