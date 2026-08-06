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

export class ShakeoutStrategy extends BaseTradingStrategy {
  public readonly macroObjective = 'shakeout' as const;

  constructor(context: TradingStrategyContext) {
    super(context);
  }

  public async onInit(): Promise<void> {
    this.context.setState('BUILDING_TREND');
    await this.generateTrend();
  }

  public async onExternalWhaleBuy(amountUsd: number): Promise<void> {
    const currentState = this.context.getState();
    if (currentState === 'DUMPING' || currentState === 'WAITING_FOR_LOSS_CUT') {
      return;
    }

    const dumpAmountUsd = sanitizePositiveNumber(
      amountUsd * this.context.tactics.dumpRatio,
    );
    if (dumpAmountUsd <= 0) {
      return;
    }

    this.context.setState('DUMPING');
    this.context.pauseQueue();
    await this.context.enqueueSinglePreemptiveTask({
      action: 'SELL',
      amountUsd: dumpAmountUsd,
      metadata: {
        tacticalAction: 'dump',
        externalBuyAmount: amountUsd,
      },
    });
    this.context.setState('WAITING_FOR_LOSS_CUT');
  }

  public async onExternalWhaleSell(_amountUsd: number): Promise<void> {
    return;
  }

  public async onLossCut(amountUsd: number): Promise<void> {
    if (this.context.getState() !== 'WAITING_FOR_LOSS_CUT') {
      return;
    }

    const scoopAmountUsd = sanitizePositiveNumber(amountUsd);
    if (scoopAmountUsd <= 0) {
      return;
    }

    await this.context.enqueueSinglePreemptiveTask({
      action: 'BUY',
      amountUsd: scoopAmountUsd,
      metadata: {
        tacticalAction: 'scoop',
        lossCutAmount: amountUsd,
      },
    });
    this.context.setState('BUILDING_TREND');
    this.context.resumeQueue();
    await this.generateTrend();
  }

  private async generateTrend(): Promise<void> {
    if (this.context.hasNormalWorkQueued()) {
      return;
    }

    await this.context.enqueuePulsePlan({
      side: 'buy',
      totalVolumeUsd: this.context.getBaseTotalVolumeUsd(),
      orderCount: this.context.getBaseOrderCount(),
      durationMs: this.context.getBaseDurationMs(),
      enqueue: 'normal',
      metadata: {
        basePulse: 'trend',
      },
    });
  }
}