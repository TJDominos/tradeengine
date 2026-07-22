export function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

export function nowMs(): number {
  return Date.now();
}

export function normalizeTimestampMs(value: number): number {
  return value >= 1_000_000_000_000 ? value : value * 1000;
}