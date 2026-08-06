/// <reference types="@cloudflare/workers-types" />

import type { Env } from './workerShared';

export async function handleScheduled(
  _controller: ScheduledController,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  // No scheduled tasks are wired yet; this keeps the entry surface stable for the next extraction.
}