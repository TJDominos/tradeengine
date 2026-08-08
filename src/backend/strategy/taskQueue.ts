import type { StrategyExecutionTaskPayload } from './types';
import {
  submitTask,
  type StrategyTaskExecutionContext,
} from '../workerCore';

export type StrategyQueuedTaskPriority = 'normal' | 'preemptive';

export interface StrategyQueuedTask extends StrategyExecutionTaskPayload {
  id: string;
  priority: StrategyQueuedTaskPriority;
  createdAt: number;
  delayMs: number;
  metadata?: Record<string, unknown>;
}

export interface StrategyTaskInput
  extends Omit<StrategyExecutionTaskPayload, 'scheduledAt'> {
  id?: string;
  scheduledAt?: number;
  delayMs?: number;
  metadata?: Record<string, unknown>;
}

export interface StrategyTaskQueueSnapshot {
  paused: boolean;
  runningTaskId: string | null;
  normalQueueSize: number;
  preemptiveQueueSize: number;
  nextTask: StrategyQueuedTask | null;
}

export interface StrategyTaskQueueOptions {
  onTaskError?: (task: StrategyQueuedTask, error: unknown) => void | Promise<void>;
  now?: () => number;
  dispatchContext?: StrategyTaskExecutionContext;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type StrategyTaskHandler = (task: StrategyQueuedTask) => Promise<void>;

function sortQueuedTasks(tasks: StrategyQueuedTask[]): void {
  tasks.sort((left, right) => {
    if (left.scheduledAt !== right.scheduledAt) {
      return left.scheduledAt - right.scheduledAt;
    }
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }
    return left.id.localeCompare(right.id);
  });
}

function createTaskId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `strategy-task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class StrategyTaskQueue {
  private readonly normalQueue: StrategyQueuedTask[] = [];

  private readonly preemptiveQueue: StrategyQueuedTask[] = [];

  private paused = false;

  private draining = false;

  private runningTaskId: string | null = null;

  private timer: TimerHandle | null = null;

  private readonly now: () => number;

  constructor(
    private readonly taskHandler?: StrategyTaskHandler,
    private readonly options: StrategyTaskQueueOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  enqueueNormal(task: StrategyTaskInput): StrategyQueuedTask {
    const queuedTask = this.normalizeTask('normal', task);
    this.normalQueue.push(queuedTask);
    sortQueuedTasks(this.normalQueue);
    this.reschedule();
    return queuedTask;
  }

  enqueuePreemptive(task: StrategyTaskInput): StrategyQueuedTask {
    const queuedTask = this.normalizeTask('preemptive', task);
    this.preemptiveQueue.push(queuedTask);
    sortQueuedTasks(this.preemptiveQueue);
    this.reschedule();
    return queuedTask;
  }

  pause(): void {
    this.paused = true;
    this.reschedule();
  }

  resume(): void {
    this.paused = false;
    this.reschedule();
  }

  isPaused(): boolean {
    return this.paused;
  }

  snapshot(): StrategyTaskQueueSnapshot {
    return {
      paused: this.paused,
      runningTaskId: this.runningTaskId,
      normalQueueSize: this.normalQueue.length,
      preemptiveQueueSize: this.preemptiveQueue.length,
      nextTask: this.peekNextEligibleTask(),
    };
  }

  clear(): void {
    this.normalQueue.length = 0;
    this.preemptiveQueue.length = 0;
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private normalizeTask(
    priority: StrategyQueuedTaskPriority,
    task: StrategyTaskInput,
  ): StrategyQueuedTask {
    const createdAt = this.now();
    const delayMs = Math.max(0, Math.round(task.delayMs ?? 0));
    const scheduledAt = Math.max(
      createdAt,
      Math.round(task.scheduledAt ?? createdAt + delayMs),
    );
    return {
      id: task.id ?? createTaskId(),
      priority,
      createdAt,
      delayMs,
      action: task.action,
      accountId: task.accountId,
      walletAddress: task.walletAddress,
      baseTokenAddress: task.baseTokenAddress,
      requestedAmount: task.requestedAmount,
      scheduledAt,
      metadata: task.metadata,
    };
  }

  private peekNextEligibleTask(): StrategyQueuedTask | null {
    const nextPreemptive = this.preemptiveQueue[0] ?? null;
    const nextNormal = !this.paused ? this.normalQueue[0] ?? null : null;
    if (!nextPreemptive) {
      return nextNormal;
    }
    if (!nextNormal) {
      return nextPreemptive;
    }
    return nextPreemptive.scheduledAt <= nextNormal.scheduledAt
      ? nextPreemptive
      : nextNormal;
  }

  private getReadyTask(now: number): StrategyQueuedTask | null {
    const duePreemptive = this.preemptiveQueue[0];
    if (duePreemptive && duePreemptive.scheduledAt <= now) {
      return this.preemptiveQueue.shift() ?? null;
    }
    if (this.paused) {
      return null;
    }
    const dueNormal = this.normalQueue[0];
    if (dueNormal && dueNormal.scheduledAt <= now) {
      return this.normalQueue.shift() ?? null;
    }
    return null;
  }

  private getNextWakeDelay(): number | null {
    const nextTask = this.peekNextEligibleTask();
    if (!nextTask) {
      return null;
    }
    return Math.max(0, nextTask.scheduledAt - this.now());
  }

  private reschedule(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.draining) {
      return;
    }
    const nextWakeDelay = this.getNextWakeDelay();
    if (nextWakeDelay == null) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, nextWakeDelay);
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (true) {
        const task = this.getReadyTask(this.now());
        if (!task) {
          break;
        }
        this.runningTaskId = task.id;
        try {
          await this.dispatchTask(task);
        } catch (error: unknown) {
          await this.options.onTaskError?.(task, error);
        } finally {
          this.runningTaskId = null;
        }
      }
    } finally {
      this.draining = false;
      this.reschedule();
    }
  }

  private async dispatchTask(task: StrategyQueuedTask): Promise<void> {
    if (this.taskHandler) {
      await this.taskHandler(task);
      return;
    }
    if (this.options.dispatchContext) {
      await submitTask(task, this.options.dispatchContext);
      return;
    }
    throw new Error('No task dispatcher is configured for StrategyTaskQueue');
  }
}

export { StrategyTaskQueue as TaskQueue };
export type { StrategyQueuedTask as TradeTask, StrategyTaskInput as TradeTaskInput };