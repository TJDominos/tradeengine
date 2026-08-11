const MIN_RESERVE_USD = 0.000001;

export type StrategyPriceCurveReview = {
  targetVolatilityPct: number | null;
  projectedVolatilityPct: number | null;
  startPriceUsd: number | null;
  projectedLowPriceUsd: number | null;
  projectedHighPriceUsd: number | null;
  liquidityUsd: number | null;
  available: boolean;
};

function roundToSixDecimals(value: number): number {
  return Number(value.toFixed(6));
}

export function buildStrategyPriceCurveReview(input: {
  tasks: Array<{ side: 'buy' | 'sell'; totalVolumeUsd: number }>;
  targetVolatilityPct: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
}): StrategyPriceCurveReview {
  const targetVolatilityPct = Number.isFinite(input.targetVolatilityPct) && input.targetVolatilityPct > 0
    ? input.targetVolatilityPct
    : null;
  const priceUsd = input.priceUsd != null && Number.isFinite(input.priceUsd) && input.priceUsd > 0
    ? input.priceUsd
    : null;
  const liquidityUsd = input.liquidityUsd != null &&
    Number.isFinite(input.liquidityUsd) && input.liquidityUsd > 0
    ? input.liquidityUsd
    : null;
  if (priceUsd == null || liquidityUsd == null) {
    return {
      targetVolatilityPct,
      projectedVolatilityPct: null,
      startPriceUsd: priceUsd,
      projectedLowPriceUsd: null,
      projectedHighPriceUsd: null,
      liquidityUsd,
      available: false,
    };
  }

  const initialQuoteReserveUsd = liquidityUsd / 2;
  let quoteReserveUsd = initialQuoteReserveUsd;
  let projectedLowPriceUsd = priceUsd;
  let projectedHighPriceUsd = priceUsd;
  for (const task of input.tasks) {
    const volumeUsd = Math.max(0, task.totalVolumeUsd);
    quoteReserveUsd = task.side === 'buy'
      ? quoteReserveUsd + volumeUsd
      : Math.max(MIN_RESERVE_USD, quoteReserveUsd - volumeUsd);
    const projectedPriceUsd = priceUsd * (quoteReserveUsd / initialQuoteReserveUsd) ** 2;
    projectedLowPriceUsd = Math.min(projectedLowPriceUsd, projectedPriceUsd);
    projectedHighPriceUsd = Math.max(projectedHighPriceUsd, projectedPriceUsd);
  }
  return {
    targetVolatilityPct,
    projectedVolatilityPct: roundToSixDecimals(
      ((projectedHighPriceUsd - projectedLowPriceUsd) / projectedLowPriceUsd) * 100,
    ),
    startPriceUsd: priceUsd,
    projectedLowPriceUsd: roundToSixDecimals(projectedLowPriceUsd),
    projectedHighPriceUsd: roundToSixDecimals(projectedHighPriceUsd),
    liquidityUsd,
    available: true,
  };
}