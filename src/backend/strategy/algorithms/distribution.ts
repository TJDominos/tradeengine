import {
  BaseTradingStrategy,
  type TradingStrategyContext,
} from './baseStrategy';
import { splitBasePlannedTransactionCount } from '../plannedTransactions';

function sanitizePositiveNumber(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

export class DistributionStrategy extends BaseTradingStrategy {
  public readonly macroObjective = 'distribution' as const;

  constructor(context: TradingStrategyContext) {
    super(context);
  }

  public async onInit(): Promise<void> {
    this.context.setState('DISTRIBUTING');
    await this.generateDistributionTrades();
  }

  public async onExternalWhaleBuy(amountUsd: number): Promise<void> {
    const totalSellUsd = sanitizePositiveNumber(
      amountUsd * this.context.tactics.followSellRatio,
    );
    if (totalSellUsd <= 0) {
      return;
    }

    const chunkCount = this.context.getDistributionChunkCount();
    const maxDelayMs = this.context.getDistributionChunkDelayJitterMs();

    this.context.setState('DISTRIBUTING');
    for (let index = 0; index < chunkCount; index += 1) {
      await this.context.enqueueSinglePreemptiveTask({
        action: 'SELL',
        amountUsd: totalSellUsd / chunkCount,
        delayMs: Math.round(this.context.random() * maxDelayMs),
        metadata: {
          tacticalAction: 'follow_sell',
          externalBuyAmount: amountUsd,
          chunkIndex: index + 1,
          chunkCount,
        },
      });
    }
    await this.generateDistributionTrades();
  }

  public async onExternalWhaleSell(_amountUsd: number): Promise<void> {
    return;
  }

  public async onLossCut(_amountUsd: number): Promise<void> {
    return;
  }

  private async generateDistributionTrades(): Promise<void> {
    if (this.context.hasNormalWorkQueued()) {
      return;
    }

    const { buyCount, sellCount } = splitBasePlannedTransactionCount(
      this.context.macroObjective,
      this.context.getBaseOrderCount(),
    );
    const totalVolumeUsd = this.context.getBaseTotalVolumeUsd();
    const totalOrders = Math.max(1, buyCount + sellCount);

    if (sellCount > 0) {
      const sellVolumeUsd = (totalVolumeUsd * sellCount) / totalOrders;
      await this.context.enqueuePulsePlan({
        side: 'sell',
        totalVolumeUsd: sellVolumeUsd,
        orderCount: sellCount,
        durationMs: this.context.getBaseDurationMs(),
        enqueue: 'normal',
        metadata: {
          basePulse: 'distribution_sell',
        },
      });
    }

    if (buyCount > 0) {
      const buyVolumeUsd = (totalVolumeUsd * buyCount) / totalOrders;
      await this.context.enqueuePulsePlan({
        side: 'buy',
        totalVolumeUsd: buyVolumeUsd,
        orderCount: buyCount,
        durationMs: this.context.getBaseDurationMs(),
        enqueue: 'normal',
        scheduledOffsetMs: 750,
        metadata: {
          basePulse: 'support_buy',
        },
      });
    }
  }
}