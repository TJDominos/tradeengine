/// <reference types="@cloudflare/workers-types" />

import { handleScheduled } from './backend/cronJobs';
import { appRouter } from './backend/router';
import type { Env } from './backend/workerShared';

export { StrategyEngineDurableObject } from './backend/strategy/strategyEngineDO';

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return appRouter(request, env, ctx);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    return handleScheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
