import { nowMs } from '../time';
import type { StrategyTriggerEvent } from './types';

export function buildWebhookStrategyTrigger(input: {
  eventType: string;
  externalId: string;
  contractAddress: string;
  walletAddress: string | null;
  txSignature: string | null;
  payloadJson?: string | null;
}): StrategyTriggerEvent {
  return {
    source: 'alchemy_notify',
    eventType: input.eventType,
    externalId: input.externalId,
    contractAddress: input.contractAddress,
    walletAddress: input.walletAddress,
    txSignature: input.txSignature,
    triggeredAt: nowMs(),
    payloadJson: input.payloadJson ?? null,
  };
}

export function buildManualRefreshStrategyTrigger(input: {
  contractAddress: string;
  externalId?: string | null;
}): StrategyTriggerEvent {
  return {
    source: 'manual_refresh',
    eventType: 'market_snapshot.refresh',
    externalId: input.externalId ?? null,
    contractAddress: input.contractAddress,
    walletAddress: null,
    txSignature: null,
    triggeredAt: nowMs(),
    payloadJson: null,
  };
}

export function buildManualTradeStrategyTrigger(input: {
  contractAddress: string;
  walletAddress: string;
  txSignature?: string | null;
  externalId?: string | null;
  eventType?: string;
}): StrategyTriggerEvent {
  return {
    source: 'manual_trade',
    eventType: input.eventType ?? 'trade.submit',
    externalId: input.externalId ?? null,
    contractAddress: input.contractAddress,
    walletAddress: input.walletAddress,
    txSignature: input.txSignature ?? null,
    triggeredAt: nowMs(),
    payloadJson: null,
  };
}