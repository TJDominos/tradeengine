import type { StrategyParameters } from '../strategy/types.ts';

export type TradeDirection = 'BUY' | 'SELL' | 'UNKNOWN';

type StrategyConfig = Pick<StrategyParameters, 'baseTokenAddress'> & {
  ammPoolAddress?: string | null;
};

type TokenTransferLike = {
  mint?: unknown;
  tokenAddress?: unknown;
  asset?: unknown;
  sender?: unknown;
  receiver?: unknown;
  fromAddress?: unknown;
  toAddress?: unknown;
  sourceOwner?: unknown;
  destinationOwner?: unknown;
  fromOwner?: unknown;
  toOwner?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(value: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base58 character');
    }
    let carry = index;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char === '1') {
      bytes.push(0);
      continue;
    }
    break;
  }
  return new Uint8Array(bytes.reverse());
}

function normalizePubkey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Account address is required');
  }
  const decoded = base58Decode(trimmed);
  if (decoded.length !== 32) {
    throw new Error('Account address must decode to 32 bytes');
  }
  return trimmed;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function tryNormalizeSolanaPubkey(value: unknown): string | null {
  const text = readNonEmptyString(value);
  if (!text) {
    return null;
  }
  try {
    return normalizePubkey(text);
  } catch {
    return null;
  }
}

function readTransfers(payload: unknown): TokenTransferLike[] {
  if (!isRecord(payload)) {
    return [];
  }

  const directTransfers = Array.isArray(payload.tokenTransfers)
    ? payload.tokenTransfers
    : [];
  if (directTransfers.length > 0) {
    return directTransfers.filter(isRecord) as TokenTransferLike[];
  }

  const event = isRecord(payload.event) ? payload.event : null;
  const eventTransfers = event && Array.isArray(event.tokenTransfers)
    ? event.tokenTransfers
    : [];
  if (eventTransfers.length > 0) {
    return eventTransfers.filter(isRecord) as TokenTransferLike[];
  }

  const activity = event && Array.isArray(event.activity)
    ? event.activity.filter(isRecord)
    : [];
  const embeddedActivityTransfers = activity.flatMap((item) => {
    const transfers = Array.isArray(item.tokenTransfers)
      ? item.tokenTransfers.filter(isRecord)
      : [];
    return transfers.map((transfer) => ({
      mint:
        transfer.mint ??
        transfer.tokenAddress ??
        (item.rawContract && isRecord(item.rawContract)
          ? item.rawContract.address
          : item.mint ?? item.tokenAddress ?? item.contractAddress),
      sender:
        transfer.sender ??
        transfer.sourceOwner ??
        transfer.fromOwner ??
        transfer.fromAddress ??
        item.fromAddress,
      receiver:
        transfer.receiver ??
        transfer.destinationOwner ??
        transfer.toOwner ??
        transfer.toAddress ??
        item.toAddress,
      sourceOwner:
        transfer.sourceOwner ??
        transfer.sender ??
        transfer.fromOwner ??
        transfer.fromAddress ??
        item.fromAddress,
      destinationOwner:
        transfer.destinationOwner ??
        transfer.receiver ??
        transfer.toOwner ??
        transfer.toAddress ??
        item.toAddress,
      fromAddress: transfer.fromAddress ?? item.fromAddress,
      toAddress: transfer.toAddress ?? item.toAddress,
    }));
  });
  if (embeddedActivityTransfers.length > 0) {
    return embeddedActivityTransfers.filter((item) => item.mint != null);
  }

  const mappedActivity = activity
    .map((item) => ({
      mint: item.rawContract && isRecord(item.rawContract)
        ? item.rawContract.address ?? item.mint ?? item.tokenAddress ?? item.contractAddress
        : item.mint ?? item.tokenAddress ?? item.contractAddress,
      sender: item.fromAddress,
      receiver: item.toAddress,
      sourceOwner: item.fromAddress,
      destinationOwner: item.toAddress,
    }))
    .filter((item) => item.mint != null);

  return mappedActivity;
}

function readNormalizedMint(transfer: TokenTransferLike): string | null {
  const mintCandidate =
    transfer.mint ??
    transfer.tokenAddress ??
    transfer.asset;
  return tryNormalizeSolanaPubkey(mintCandidate);
}

function readNormalizedAddress(value: unknown): string | null {
  return tryNormalizeSolanaPubkey(value);
}

function collectNormalizedAddresses(values: unknown[]): string[] {
  const addresses = new Set<string>();
  for (const value of values) {
    const normalized = readNormalizedAddress(value);
    if (normalized) {
      addresses.add(normalized);
    }
  }
  return [...addresses];
}

export function analyzeTradeDirection(
  webhookPayload: unknown,
  config: StrategyConfig,
): TradeDirection {
  const baseTokenAddress = config.baseTokenAddress.trim();
  const ammPoolAddress = config.ammPoolAddress.trim();

  if (!baseTokenAddress || !ammPoolAddress) {
    return 'UNKNOWN';
  }

  const normalizedBaseTokenAddress = normalizePubkey(baseTokenAddress);
  const normalizedAmmPoolAddress = normalizePubkey(ammPoolAddress);
  const transfers = readTransfers(webhookPayload);

  for (const transfer of transfers) {
    const transferMint = readNormalizedMint(transfer);
    if (transferMint !== normalizedBaseTokenAddress) {
      continue;
    }

    const senders = collectNormalizedAddresses([
      transfer.sender,
      transfer.sourceOwner,
      transfer.fromOwner,
      transfer.fromAddress,
    ]);
    const receivers = collectNormalizedAddresses([
      transfer.receiver,
      transfer.destinationOwner,
      transfer.toOwner,
      transfer.toAddress,
    ]);

    if (senders.includes(normalizedAmmPoolAddress)) {
      return 'BUY';
    }
    if (receivers.includes(normalizedAmmPoolAddress)) {
      return 'SELL';
    }
  }

  return 'UNKNOWN';
}