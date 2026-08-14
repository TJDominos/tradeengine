const MIN_RESERVE_USD = 0.000001;

export type StrategyPriceCurvePoint = {
  index: number;
  side: 'buy' | 'sell' | 'start';
  scheduledAt: number | null;
  elapsedMs: number | null;
  volumeUsd: number;
  netFlowUsd: number;
  cumulativeNetFlowUsd: number;
  priceUsd: number | null;
  priceChangePct: number | null;
  slopePct: number | null;
  slopePctPerHour: number | null;
};

export type StrategyPriceCurveReview = {
  targetVolatilityPct: number | null;
  projectedVolatilityPct: number | null;
  maxDrawdownPct: number | null;
  startPriceUsd: number | null;
  projectedLowPriceUsd: number | null;
  projectedHighPriceUsd: number | null;
  liquidityUsd: number | null;
  available: boolean;
  points: StrategyPriceCurvePoint[];
};

function roundToSixDecimals(value: number): number {
  return Number(value.toFixed(6));
}

export function buildStrategyPriceCurveReview(input: {
  tasks: Array<{ side: 'buy' | 'sell'; totalVolumeUsd: number; scheduledAt?: number }>;
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
  const startScheduledAt = input.tasks.find((task) => Number.isFinite(task.scheduledAt))?.scheduledAt ?? null;
  if (priceUsd == null || liquidityUsd == null) {
    return {
      targetVolatilityPct,
      projectedVolatilityPct: null,
      maxDrawdownPct: null,
      startPriceUsd: priceUsd,
      projectedLowPriceUsd: null,
      projectedHighPriceUsd: null,
      liquidityUsd,
      available: false,
      points: [{
        index: 0,
        side: 'start',
        scheduledAt: startScheduledAt,
        elapsedMs: 0,
        volumeUsd: 0,
        netFlowUsd: 0,
        cumulativeNetFlowUsd: 0,
        priceUsd,
        priceChangePct: null,
        slopePct: null,
        slopePctPerHour: null,
      }],
    };
  }

  const initialQuoteReserveUsd = liquidityUsd / 2;
  let quoteReserveUsd = initialQuoteReserveUsd;
  let projectedLowPriceUsd = priceUsd;
  let projectedHighPriceUsd = priceUsd;
  let previousPriceUsd = priceUsd;
  let previousScheduledAt = startScheduledAt;
  let cumulativeNetFlowUsd = 0;
  const points: StrategyPriceCurvePoint[] = [{
    index: 0,
    side: 'start',
    scheduledAt: startScheduledAt,
    elapsedMs: 0,
    volumeUsd: 0,
    netFlowUsd: 0,
    cumulativeNetFlowUsd: 0,
    priceUsd: roundToSixDecimals(priceUsd),
    priceChangePct: 0,
    slopePct: null,
    slopePctPerHour: null,
  }];
  for (const task of input.tasks) {
    const volumeUsd = Math.max(0, task.totalVolumeUsd);
    const netFlowUsd = task.side === 'buy' ? volumeUsd : -volumeUsd;
    cumulativeNetFlowUsd += netFlowUsd;
    quoteReserveUsd = task.side === 'buy'
      ? quoteReserveUsd + volumeUsd
      : Math.max(MIN_RESERVE_USD, quoteReserveUsd - volumeUsd);
    const projectedPriceUsd = priceUsd * (quoteReserveUsd / initialQuoteReserveUsd) ** 2;
    projectedLowPriceUsd = Math.min(projectedLowPriceUsd, projectedPriceUsd);
    projectedHighPriceUsd = Math.max(projectedHighPriceUsd, projectedPriceUsd);
    const scheduledAt = Number.isFinite(task.scheduledAt) ? task.scheduledAt ?? null : null;
    const elapsedMs = scheduledAt != null && startScheduledAt != null
      ? Math.max(0, scheduledAt - startScheduledAt)
      : null;
    const slopePct = ((projectedPriceUsd - previousPriceUsd) / previousPriceUsd) * 100;
    const elapsedHours = scheduledAt != null && previousScheduledAt != null
      ? Math.max(0, scheduledAt - previousScheduledAt) / 3_600_000
      : 0;
    points.push({
      index: points.length,
      side: task.side,
      scheduledAt,
      elapsedMs,
      volumeUsd: roundToSixDecimals(volumeUsd),
      netFlowUsd: roundToSixDecimals(netFlowUsd),
      cumulativeNetFlowUsd: roundToSixDecimals(cumulativeNetFlowUsd),
      priceUsd: roundToSixDecimals(projectedPriceUsd),
      priceChangePct: roundToSixDecimals(((projectedPriceUsd - priceUsd) / priceUsd) * 100),
      slopePct: roundToSixDecimals(slopePct),
      slopePctPerHour: elapsedHours > 0 ? roundToSixDecimals(slopePct / elapsedHours) : null,
    });
    previousPriceUsd = projectedPriceUsd;
    previousScheduledAt = scheduledAt;
  }
  return {
    targetVolatilityPct,
    projectedVolatilityPct: roundToSixDecimals(
      ((projectedHighPriceUsd - projectedLowPriceUsd) / projectedLowPriceUsd) * 100,
    ),
    maxDrawdownPct: roundToSixDecimals(
      Math.max(0, ((priceUsd - projectedLowPriceUsd) / priceUsd) * 100),
    ),
    startPriceUsd: priceUsd,
    projectedLowPriceUsd: roundToSixDecimals(projectedLowPriceUsd),
    projectedHighPriceUsd: roundToSixDecimals(projectedHighPriceUsd),
    liquidityUsd,
    available: true,
    points,
  };
}