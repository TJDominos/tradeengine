const MIN_VOLUME_EPSILON = 0.000001;

export type TradeTotals = {
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  grossVolumeUsd: number;
  netBuyVolumeUsd: number;
};

export type FeasibleTradeCounts = {
  buyCount: number;
  sellCount: number;
};

export type ObservedPlanOrder = {
  side: 'buy' | 'sell';
  volumeUsd: number;
  source: 'managed' | 'external';
  responseBuyVolumeUsd?: number;
  responseSellVolumeUsd?: number;
};

export function calculateRemainingPlanVolumes(
  baseBuyVolumeUsd: number,
  baseSellVolumeUsd: number,
  observedOrders: ObservedPlanOrder[],
) {
  let desiredBuyVolumeUsd = Math.max(0, baseBuyVolumeUsd);
  let desiredSellVolumeUsd = Math.max(0, baseSellVolumeUsd);
  let executedBuyVolumeUsd = 0;
  let executedSellVolumeUsd = 0;
  for (const order of observedOrders) {
    desiredBuyVolumeUsd += Math.max(0, order.responseBuyVolumeUsd ?? 0);
    desiredSellVolumeUsd += Math.max(0, order.responseSellVolumeUsd ?? 0);
    if (order.source !== 'managed') {
      continue;
    }
    if (order.side === 'buy') {
      executedBuyVolumeUsd += Math.max(0, order.volumeUsd);
    } else {
      executedSellVolumeUsd += Math.max(0, order.volumeUsd);
    }
  }
  return {
    desiredBuyVolumeUsd: roundToSixDecimals(desiredBuyVolumeUsd),
    desiredSellVolumeUsd: roundToSixDecimals(desiredSellVolumeUsd),
    executedBuyVolumeUsd: roundToSixDecimals(executedBuyVolumeUsd),
    executedSellVolumeUsd: roundToSixDecimals(executedSellVolumeUsd),
    remainingBuyVolumeUsd: roundToSixDecimals(
      Math.max(0, desiredBuyVolumeUsd - executedBuyVolumeUsd),
    ),
    remainingSellVolumeUsd: roundToSixDecimals(
      Math.max(0, desiredSellVolumeUsd - executedSellVolumeUsd),
    ),
  };
}

export type BoundedAllocationCandidate = {
  accountId: number;
  maxVolumeUsd: number;
  existingPlannedVolumeUsd: number;
};

export type BoundedAllocation = {
  accountId: number;
  volumeUsd: number;
};

function roundToSixDecimals(value: number): number {
  return Number(value.toFixed(6));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function calculateSelfCyclingTradeTotals(
  targetGrossVolumeUsd: number,
  requiredNetBuyVolumeUsd: number,
  minimumSellVolumeUsd: number,
): TradeTotals {
  const normalizedGross = Math.max(0, targetGrossVolumeUsd);
  const netBuyVolumeUsd = Math.min(
    normalizedGross,
    Math.max(0, requiredNetBuyVolumeUsd),
  );
  const targetSellVolumeUsd = Math.max(
    0,
    (normalizedGross - netBuyVolumeUsd) / 2,
    minimumSellVolumeUsd,
  );
  const sellVolumeUsd = roundToSixDecimals(targetSellVolumeUsd);
  const buyVolumeUsd = roundToSixDecimals(netBuyVolumeUsd + sellVolumeUsd);
  return {
    buyVolumeUsd,
    sellVolumeUsd,
    grossVolumeUsd: roundToSixDecimals(buyVolumeUsd + sellVolumeUsd),
    netBuyVolumeUsd: roundToSixDecimals(buyVolumeUsd - sellVolumeUsd),
  };
}

function deriveOrderCountBounds(
  volumeUsd: number,
  minOrderUsd: number,
  maxOrderUsd: number,
): { minimum: number; maximum: number } | null {
  if (volumeUsd <= MIN_VOLUME_EPSILON) {
    return { minimum: 0, maximum: 0 };
  }
  const minimum = Math.max(1, Math.ceil((volumeUsd - MIN_VOLUME_EPSILON) / maxOrderUsd));
  const maximum = Math.floor((volumeUsd + MIN_VOLUME_EPSILON) / minOrderUsd);
  return minimum <= maximum ? { minimum, maximum } : null;
}

export function calculateFeasibleTradeCounts(
  preferredTotalOrders: number,
  maximumTotalOrders: number,
  buyVolumeUsd: number,
  sellVolumeUsd: number,
  minOrderUsd: number,
  maxOrderUsd: number,
): FeasibleTradeCounts | null {
  if (
    !Number.isFinite(minOrderUsd) ||
    !Number.isFinite(maxOrderUsd) ||
    minOrderUsd <= 0 ||
    maxOrderUsd < minOrderUsd
  ) {
    return null;
  }
  const buyBounds = deriveOrderCountBounds(buyVolumeUsd, minOrderUsd, maxOrderUsd);
  const sellBounds = deriveOrderCountBounds(sellVolumeUsd, minOrderUsd, maxOrderUsd);
  if (!buyBounds || !sellBounds) {
    return null;
  }
  const minimumTotal = buyBounds.minimum + sellBounds.minimum;
  const maximumTotal = Math.min(
    Math.max(0, Math.floor(maximumTotalOrders)),
    buyBounds.maximum + sellBounds.maximum,
  );
  if (minimumTotal > maximumTotal) {
    return null;
  }

  const requestedMinimum = Math.max(1, Math.floor(preferredTotalOrders));
  if (requestedMinimum > maximumTotal) {
    return null;
  }
  const totalOrders = Math.max(requestedMinimum, minimumTotal);
  const totalVolumeUsd = buyVolumeUsd + sellVolumeUsd;
  const preferredBuyCount = totalVolumeUsd > MIN_VOLUME_EPSILON
    ? Math.round(totalOrders * buyVolumeUsd / totalVolumeUsd)
    : 0;
  const buyCount = clamp(
    preferredBuyCount,
    Math.max(buyBounds.minimum, totalOrders - sellBounds.maximum),
    Math.min(buyBounds.maximum, totalOrders - sellBounds.minimum),
  );
  return {
    buyCount,
    sellCount: totalOrders - buyCount,
  };
}

function orderCandidates(
  candidates: BoundedAllocationCandidate[],
  targetVolumeUsd: number,
  dispersionStrength: number,
  accountCyclingEnabled: boolean,
  rotationOffset: number,
  random: () => number,
): BoundedAllocationCandidate[] {
  const normalizedStrength = Math.max(0, dispersionStrength);
  const fairnessWeight = normalizedStrength / (1 + normalizedStrength);
  const candidateCount = candidates.length;
  return candidates
    .map((candidate, index) => {
      const capacityCoverage = Math.min(1, candidate.maxVolumeUsd / targetVolumeUsd);
      const normalizedExistingVolume = candidate.existingPlannedVolumeUsd / targetVolumeUsd;
      const rotationRank = candidateCount > 0
        ? ((index - rotationOffset) % candidateCount + candidateCount) % candidateCount
        : 0;
      return {
        candidate,
        score:
          (1 - fairnessWeight) * (1 - capacityCoverage) +
          fairnessWeight * normalizedExistingVolume,
        rotationRank,
        tieBreaker: random(),
      };
    })
    .sort((left, right) =>
      left.score - right.score ||
      (accountCyclingEnabled
        ? left.rotationRank - right.rotationRank
        : left.tieBreaker - right.tieBreaker) ||
      left.candidate.accountId - right.candidate.accountId,
    )
    .map(({ candidate }) => candidate);
}

export function allocateBoundedOrderVolume(
  targetVolumeUsd: number,
  candidates: BoundedAllocationCandidate[],
  options: {
    minOrderUsd: number;
    accountCyclingEnabled: boolean;
    rotationOffset: number;
    accountDispersionStrength: number;
    random: () => number;
  },
): {
  allocations: BoundedAllocation[];
  unallocatedVolumeUsd: number;
  nextRotationOffset: number;
} {
  const normalizedTarget = roundToSixDecimals(Math.max(0, targetVolumeUsd));
  const normalizedMinimum = roundToSixDecimals(
    Math.max(MIN_VOLUME_EPSILON, options.minOrderUsd),
  );
  const eligibleCandidates = candidates.filter(
    (candidate) => candidate.maxVolumeUsd + MIN_VOLUME_EPSILON >= normalizedMinimum,
  );
  const rotationOffset = options.accountCyclingEnabled ? options.rotationOffset : 0;
  const nextRotationOffset = options.accountCyclingEnabled && eligibleCandidates.length > 0
    ? (rotationOffset + 1) % eligibleCandidates.length
    : 0;
  if (normalizedTarget < normalizedMinimum || eligibleCandidates.length === 0) {
    return {
      allocations: [],
      unallocatedVolumeUsd: normalizedTarget,
      nextRotationOffset,
    };
  }

  const orderedCandidates = orderCandidates(
    eligibleCandidates,
    normalizedTarget,
    options.accountDispersionStrength,
    options.accountCyclingEnabled,
    rotationOffset,
    options.random,
  );
  const allocations: BoundedAllocation[] = [];
  let remainingVolumeUsd = normalizedTarget;
  for (const candidate of orderedCandidates) {
    if (remainingVolumeUsd + MIN_VOLUME_EPSILON < normalizedMinimum) {
      break;
    }
    let volumeUsd = roundToSixDecimals(
      Math.min(candidate.maxVolumeUsd, remainingVolumeUsd),
    );
    const remainder = roundToSixDecimals(remainingVolumeUsd - volumeUsd);
    if (remainder > 0 && remainder < normalizedMinimum) {
      const adjustedVolume = roundToSixDecimals(
        volumeUsd - (normalizedMinimum - remainder),
      );
      if (adjustedVolume + MIN_VOLUME_EPSILON >= normalizedMinimum) {
        volumeUsd = adjustedVolume;
      }
    }
    if (volumeUsd + MIN_VOLUME_EPSILON < normalizedMinimum) {
      continue;
    }
    allocations.push({ accountId: candidate.accountId, volumeUsd });
    remainingVolumeUsd = roundToSixDecimals(remainingVolumeUsd - volumeUsd);
  }
  return {
    allocations,
    unallocatedVolumeUsd: Math.max(0, remainingVolumeUsd),
    nextRotationOffset,
  };
}