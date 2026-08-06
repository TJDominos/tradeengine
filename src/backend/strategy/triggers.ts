import { nowMs } from '../time';
import type { StrategyTriggerEvent } from './types';

export interface ExternalTradeEvent {
  type: 'whale_buy' | 'whale_sell';
  amount: number;
  contractAddress: string;
  txHash: string;
  wallet_address: string;
  is_loss_cut: boolean;
}

export interface StrategyEventRouterTarget {
  readonly contractAddress: string;
  onExternalWhaleBuy(amountUsd: number): Promise<void> | void;
  onExternalWhaleSell(amountUsd: number): Promise<void> | void;
  onLossCut(amountUsd: number): Promise<void> | void;
}

export class TriggerHandler {
  constructor(
    private readonly engine: StrategyEventRouterTarget,
    private readonly triggerThresholdUsd: number,
  ) {}

  public async handleWebhookEvent(event: ExternalTradeEvent): Promise<void> {
    if (event.contractAddress !== this.engine.contractAddress) {
      console.warn(
        `[Trigger] Skipping event for ${event.contractAddress}; engine is bound to ${this.engine.contractAddress}`,
      );
      return;
    }

    console.log(
      `[Trigger] Received event ${event.txHash}: ${event.type} of $${event.amount} on ${event.contractAddress} from ${event.wallet_address}. LossCut: ${event.is_loss_cut}`,
    );

    const amount = Number.isFinite(event.amount) ? event.amount : 0;

    if (event.type === 'whale_buy' && amount >= this.triggerThresholdUsd) {
      await this.engine.onExternalWhaleBuy(amount);
    }

    if (event.type === 'whale_sell' && amount >= this.triggerThresholdUsd) {
      await this.engine.onExternalWhaleSell(amount);
    }

    if (event.is_loss_cut) {
      await this.engine.onLossCut(amount);
    }
  }
}

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