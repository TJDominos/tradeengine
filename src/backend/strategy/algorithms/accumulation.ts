import {
  BaseTradingStrategy,
  type TradingStrategyContext,
} from './baseStrategy';

function sanitizePositiveNumber(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

export class AccumulationStrategy extends BaseTradingStrategy {
  public readonly macroObjective = 'accumulation' as const;

  constructor(context: TradingStrategyContext) {
    super(context);
  }

  public async onInit(): Promise<void> {
    this.context.setState('ACCUMULATING');
    await this.generateSlowBuys();
  }

  public async onExternalWhaleBuy(_amountUsd: number): Promise<void> {
    return;
  }

  public async onExternalWhaleSell(amountUsd: number): Promise<void> {
    const absorbAmountUsd = sanitizePositiveNumber(
      amountUsd * this.context.tactics.absorbRatio,
    );
    if (absorbAmountUsd <= 0) {
      return;
    }

    this.context.setState('ACCUMULATING');
    await this.context.enqueueSinglePreemptiveTask({
      action: 'BUY',
      amountUsd: absorbAmountUsd,
      metadata: {
        tacticalAction: 'absorb',
        externalSellAmount: amountUsd,
      },
    });
    await this.generateSlowBuys();
  }

  public async onLossCut(_amountUsd: number): Promise<void> {
    return;
  }

  private async generateSlowBuys(): Promise<void> {
    if (this.context.hasNormalWorkQueued()) {
      return;
    }

    await this.context.enqueuePulsePlan({
      side: 'buy',
      totalVolumeUsd: this.context.getBaseTotalVolumeUsd(),
      orderCount: this.context.getBaseOrderCount(),
      durationMs: Math.round(this.context.getBaseDurationMs() * 1.5),
      enqueue: 'normal',
      metadata: {
        basePulse: 'slow_buy',
      },
    });
  }
}