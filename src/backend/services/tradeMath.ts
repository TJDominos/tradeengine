function roundToSixDecimals(value: number): number {
  return Number(value.toFixed(6));
}

const MIN_VOLUME_EPSILON = 0.000001;

export interface AccountVolumeAllocationInput {
  accountId: number;
  maxVolumeUsd: number | null;
  existingVolumeUsd?: number;
}

export interface AccountVolumeAllocationResult {
  accountId: number;
  volumeUsd: number;
}

function normalizeCapacity(value: number | null): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return roundToSixDecimals(value);
}

function hasRemainingCapacity(value: number | null): boolean {
  return value == null || value > MIN_VOLUME_EPSILON;
}

function normalizeExistingVolume(value: number | null | undefined): number {
  if (!Number.isFinite(value) || value == null || value <= 0) {
    return 0;
  }
  return roundToSixDecimals(value);
}

function buildRotatedIndices(length: number, offset: number): number[] {
  if (length <= 0) {
    return [];
  }
  const normalizedOffset = ((offset % length) + length) % length;
  return Array.from({ length }, (_, index) => (normalizedOffset + index) % length);
}

function rotateIndices<T>(items: T[], offset: number): T[] {
  if (items.length <= 1) {
    return items;
  }
  const order = buildRotatedIndices(items.length, offset);
  return order.map((index) => items[index]!);
}

function distributeVolumeByWeights(
  targetVolume: number,
  weights: number[],
): number[] {
  if (!Number.isFinite(targetVolume) || targetVolume <= 0 || weights.length === 0) {
    return [];
  }

  const sanitizedWeights = weights.map((weight) =>
    Number.isFinite(weight) && weight > 0 ? weight : 0,
  );
  const totalWeight = sanitizedWeights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return [targetVolume, ...Array.from({ length: weights.length - 1 }, () => 0)].slice(0, weights.length);
  }

  const shares = sanitizedWeights.map((weight) =>
    roundToSixDecimals((targetVolume * weight) / totalWeight),
  );
  const roundedSum = shares.reduce((sum, share) => sum + share, 0);
  const difference = roundToSixDecimals(targetVolume - roundedSum);
  shares[shares.length - 1] = roundToSixDecimals(shares[shares.length - 1] + difference);
  return shares;
}

function buildSpreadWeights(
  accounts: AccountVolumeAllocationInput[],
  orderedIndices: number[],
  targetVolume: number,
  dispersionStrength: number,
  random: () => number,
): number[] {
  const existingVolumes = orderedIndices.map((index) =>
    normalizeExistingVolume(accounts[index]?.existingVolumeUsd),
  );
  const totalExistingVolume = existingVolumes.reduce((sum, volume) => sum + volume, 0);
  const averageExistingVolume =
    orderedIndices.length > 0 ? totalExistingVolume / orderedIndices.length : 0;
  const normalizationUnit = Math.max(
    1,
    targetVolume / Math.max(1, orderedIndices.length),
    averageExistingVolume,
  );

  return existingVolumes.map((existingVolume) => {
    const normalizedStrength = Number.isFinite(dispersionStrength)
      ? Math.max(0, dispersionStrength)
      : 0;
    const dispersionWeight = Math.pow(
      1 + existingVolume / normalizationUnit,
      -normalizedStrength,
    );
    const jitter = 0.98 + random() * 0.04;
    return dispersionWeight * jitter;
  });
}

export function distributeVolumeAcrossAccounts(
  targetVolume: number,
  accountsCount: number,
  random: () => number = Math.random,
): number[] {
  if (!Number.isFinite(targetVolume) || targetVolume <= 0 || accountsCount <= 0) {
    return [];
  }

  if (accountsCount === 1) {
    return [targetVolume];
  }

  const weights = Array.from({ length: accountsCount }, () => random());
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    return [targetVolume, ...Array.from({ length: accountsCount - 1 }, () => 0)].slice(0, accountsCount);
  }

  const shares = weights.map((weight) => roundToSixDecimals((targetVolume * weight) / totalWeight));
  const roundedSum = shares.reduce((sum, share) => sum + share, 0);
  const difference = roundToSixDecimals(targetVolume - roundedSum);
  shares[shares.length - 1] = roundToSixDecimals(shares[shares.length - 1] + difference);
  return shares;
}

export function allocateVolumeAcrossAccountCaps(
  targetVolume: number,
  accounts: AccountVolumeAllocationInput[],
  options?: {
    random?: () => number;
    accountCyclingEnabled?: boolean;
    rotationOffset?: number;
    accountDispersionStrength?: number;
  },
): {
  allocations: AccountVolumeAllocationResult[];
  unallocatedVolumeUsd: number;
  nextRotationOffset: number;
} {
  const normalizedTargetVolume = roundToSixDecimals(targetVolume);
  if (!Number.isFinite(normalizedTargetVolume) || normalizedTargetVolume <= 0) {
    return {
      allocations: [],
      unallocatedVolumeUsd: 0,
      nextRotationOffset: 0,
    };
  }

  if (accounts.length === 0) {
    return {
      allocations: [],
      unallocatedVolumeUsd: normalizedTargetVolume,
      nextRotationOffset: 0,
    };
  }

  const random = options?.random ?? Math.random;
  const accountCyclingEnabled = options?.accountCyclingEnabled ?? false;
  const normalizedRotationOffset = options?.rotationOffset ?? 0;
  const accountDispersionStrength = options?.accountDispersionStrength ?? 0;
  const remainingCaps = accounts.map((account) => normalizeCapacity(account.maxVolumeUsd));
  const allocations = Array.from({ length: accounts.length }, () => 0);
  let remainingVolumeUsd = normalizedTargetVolume;

  let eligibleIndices = accounts
    .map((_, index) => index)
    .filter((index) => hasRemainingCapacity(remainingCaps[index] ?? null));

  while (remainingVolumeUsd > MIN_VOLUME_EPSILON && eligibleIndices.length > 0) {
    const orderedEligibleIndices = accountCyclingEnabled
      ? rotateIndices(eligibleIndices, normalizedRotationOffset)
      : eligibleIndices;
    const shares = distributeVolumeByWeights(
      remainingVolumeUsd,
      buildSpreadWeights(
        accounts,
        orderedEligibleIndices,
        remainingVolumeUsd,
        accountDispersionStrength,
        random,
      ),
    );
    let distributedThisRound = 0;
    const nextEligibleIndices: number[] = [];

    for (let shareIndex = 0; shareIndex < orderedEligibleIndices.length; shareIndex += 1) {
      const index = orderedEligibleIndices[shareIndex]!;
      const share = shares[shareIndex] ?? 0;
      const cap = remainingCaps[index] ?? null;
      const volumeUsd = roundToSixDecimals(
        Math.min(share, cap == null ? share : cap),
      );
      if (volumeUsd > MIN_VOLUME_EPSILON) {
        allocations[index] = roundToSixDecimals(allocations[index]! + volumeUsd);
        distributedThisRound = roundToSixDecimals(distributedThisRound + volumeUsd);
        if (cap != null) {
          remainingCaps[index] = roundToSixDecimals(Math.max(0, cap - volumeUsd));
        }
      }

      if (hasRemainingCapacity(remainingCaps[index] ?? null)) {
        nextEligibleIndices.push(index);
      }
    }

    if (distributedThisRound <= MIN_VOLUME_EPSILON) {
      break;
    }

    remainingVolumeUsd = roundToSixDecimals(
      Math.max(0, remainingVolumeUsd - distributedThisRound),
    );
    eligibleIndices = nextEligibleIndices;
  }

  return {
    allocations: allocations
      .map((volumeUsd, index) => ({
        accountId: accounts[index]!.accountId,
        volumeUsd,
      }))
      .filter((allocation) => allocation.volumeUsd > MIN_VOLUME_EPSILON),
    unallocatedVolumeUsd: remainingVolumeUsd,
    nextRotationOffset: accountCyclingEnabled && accounts.length > 0
      ? (normalizedRotationOffset + 1) % accounts.length
      : 0,
  };
}