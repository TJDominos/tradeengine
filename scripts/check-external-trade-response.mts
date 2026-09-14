import assert from 'node:assert/strict';

import { resolveExternalTradeAmountUsd } from '../src/backend/api/webhookHandler';
import { resolveExternalTradeResponse } from '../src/backend/strategy/strategyEngineDO';
import { calculateRemainingPlanVolumes } from '../src/backend/strategy/plannerMath';

const tactics = {
  dumpRatio: 1.2,
  followSellRatio: 0.8,
  absorbRatio: 1.5,
};

assert.deepEqual(
  resolveExternalTradeResponse({
    direction: 'BUY',
    amountUsd: 100,
    action: 'watch_and_wait',
    macroObjective: 'accumulation',
    tactics,
  }),
  {
    responseBuyVolumeUsd: 0,
    responseSellVolumeUsd: 0,
    targetReductionBuyVolumeUsd: 0,
    shouldPause: false,
  },
);

assert.equal(
  resolveExternalTradeResponse({
    direction: 'BUY',
    amountUsd: 100,
    action: 'reduce_target',
    macroObjective: 'accumulation',
    tactics,
  }).targetReductionBuyVolumeUsd,
  100,
);

assert.equal(
  resolveExternalTradeResponse({
    direction: 'BUY',
    amountUsd: 100,
    action: 'counter_trade',
    macroObjective: 'shakeout',
    tactics,
  }).responseSellVolumeUsd,
  120,
);

assert.equal(
  resolveExternalTradeResponse({
    direction: 'SELL',
    amountUsd: 40,
    action: 'buy_the_dip',
    macroObjective: 'accumulation',
    tactics,
  }).responseBuyVolumeUsd,
  60,
);

assert.equal(
  resolveExternalTradeResponse({
    direction: 'SELL',
    amountUsd: 40,
    action: 'pause_strategy',
    macroObjective: 'accumulation',
    tactics,
  }).shouldPause,
  true,
);

assert.deepEqual(
  calculateRemainingPlanVolumes(100, 0, [{
    side: 'buy',
    volumeUsd: 50,
    source: 'external',
    responseBuyVolumeUsd: 0,
    responseSellVolumeUsd: 0,
    targetReductionBuyVolumeUsd: 25,
  }]),
  {
    desiredBuyVolumeUsd: 75,
    desiredSellVolumeUsd: 0,
    executedBuyVolumeUsd: 0,
    executedSellVolumeUsd: 0,
    remainingBuyVolumeUsd: 75,
    remainingSellVolumeUsd: 0,
  },
);

assert.equal(
  calculateRemainingPlanVolumes(100, 0, [{
    side: 'buy',
    volumeUsd: 0,
    source: 'external',
    targetReductionBuyVolumeUsd: 125,
  }]).remainingBuyVolumeUsd,
  0,
);

assert.equal(
  resolveExternalTradeAmountUsd({ usdcAmount: 12, tokenAmount: 100 }, { priceUsd: 2 } as never),
  12,
);
assert.equal(
  resolveExternalTradeAmountUsd({ usdcAmount: null, tokenAmount: 100 }, { priceUsd: 2 } as never),
  200,
);
assert.equal(
  resolveExternalTradeAmountUsd({ usdcAmount: null, tokenAmount: 100 }, null),
  null,
);

console.log('External trade response and USD normalization check passed.');