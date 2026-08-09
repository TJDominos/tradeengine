function roundToSixDecimals(value: number): number {
  return Number(value.toFixed(6));
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