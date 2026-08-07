/// <reference types="@cloudflare/workers-types" />

import { handleScheduled } from './backend/cronJobs';
import { appRouter } from './backend/router';
import { initializeAllSchemas } from './backend/services/dbSetup';
import type { Env } from './backend/workerShared';

export { StrategyEngineDurableObject } from './backend/strategy/strategyEngineDO';

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    await initializeAllSchemas(env);
    return appRouter(request, env, ctx);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await initializeAllSchemas(env);
    return handleScheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
