function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const deliveryConfig = {
  recentConfirmedTtlSeconds: positiveNumber('DELIVERY_RECENT_CONFIRMED_TTL_SECONDS', 86_400),
  followupDelaySeconds: positiveNumber('DELIVERY_FOLLOWUP_DELAY_SECONDS', 1_800),
  reviewTtlSeconds: positiveNumber('DELIVERY_REVIEW_TTL_SECONDS', 604_800),
  pixProofMaxAgeHours: positiveNumber('DELIVERY_PIX_PROOF_MAX_AGE_HOURS', 8)
};
