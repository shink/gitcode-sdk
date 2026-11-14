import { DEFAULT_INTERVAL_MS } from '../core/config';
import { getLogger, type LoggerLike } from '../logger';
import { BoundedSet } from '../utils/dedup';

export interface EventHandlerOptions {
  /** 轮询间隔（毫秒），默认 30000。 */
  intervalMs?: number;
  /** 水位线重叠时间，默认 min(5000, intervalMs)。 */
  overlapMs?: number;
  /** 首次轮询的回看窗口（emitExisting=true 时生效）。 */
  initialLookbackMs?: number;
  /** 单次轮询最大回看时间，防止失败后窗口无限增长。 */
  maxLookbackMs?: number;
  /** 首次轮询是否补发历史事件，默认 false（建立基线）。 */
  emitExisting?: boolean;
  /** 单次分页请求最大页数，默认 50。 */
  maxPages?: number;
  /** 并发处理数量，默认 5。 */
  maxConcurrentRequests?: number;
  /** 去重集合容量，默认 10000。 */
  maxSeenEvents?: number;
  logger?: LoggerLike;
  onError?: (error: unknown) => void;
  clock?: () => number;
}

export interface ResolvedEventHandlerOptions {
  intervalMs: number;
  overlapMs: number;
  initialLookbackMs: number;
  maxLookbackMs: number;
  emitExisting: boolean;
  maxPages: number;
  maxConcurrentRequests: number;
  maxSeenEvents: number;
  logger: LoggerLike;
  onError?: (error: unknown) => void;
  clock: () => number;
}

export function resolveEventHandlerOptions(
  input: number | EventHandlerOptions = {}
): ResolvedEventHandlerOptions {
  const options = typeof input === 'number' ? { intervalMs: input } : input;
  const intervalMs = positiveInteger(options.intervalMs, DEFAULT_INTERVAL_MS, 'intervalMs');
  const overlapMs = nonNegativeInteger(options.overlapMs, Math.min(5_000, intervalMs), 'overlapMs');
  const initialLookbackMs = nonNegativeInteger(
    options.initialLookbackMs,
    intervalMs,
    'initialLookbackMs'
  );
  const maxLookbackMs = positiveInteger(
    options.maxLookbackMs,
    Math.max(intervalMs * 10, 5 * 60_000),
    'maxLookbackMs'
  );

  return {
    intervalMs,
    overlapMs,
    initialLookbackMs,
    maxLookbackMs,
    emitExisting: options.emitExisting === true,
    maxPages: positiveInteger(options.maxPages, 50, 'maxPages'),
    maxConcurrentRequests: positiveInteger(
      options.maxConcurrentRequests,
      5,
      'maxConcurrentRequests'
    ),
    maxSeenEvents: positiveInteger(options.maxSeenEvents, 10_000, 'maxSeenEvents'),
    logger: options.logger ?? getLogger(),
    onError: options.onError,
    clock: options.clock ?? (() => Date.now()),
  };
}

export interface PollingWindow {
  /** 本次查询下界（毫秒时间戳）。 */
  since: number;
  /** 本次查询下界（ISO 8601）。 */
  sinceIso: string;
  /** 上一次成功轮询的时间。 */
  previous: number;
}

/**
 * 轮询水位线与事件去重状态。
 *
 * - 首次轮询默认只建立基线，不补发历史事件；
 * - 每次查询下界 = 上次成功时间 - overlap，抵消 API 索引延迟与时钟偏差；
 * - 只有本轮全部请求成功才推进水位线，失败时下一轮会重试（去重集合避免重复回调）。
 */
export class PollingState {
  private initialized = false;
  private lastCheck: number;
  private readonly seen: BoundedSet;

  constructor(
    private readonly options: Pick<
      ResolvedEventHandlerOptions,
      'overlapMs' | 'initialLookbackMs' | 'maxLookbackMs' | 'emitExisting' | 'maxSeenEvents'
    >,
    clock: () => number = () => Date.now()
  ) {
    this.lastCheck = clock();
    this.seen = new BoundedSet(options.maxSeenEvents);
  }

  get lastCheckedAt(): number {
    return this.lastCheck;
  }

  /**
   * 开始一轮检查。返回 null 表示这是用于建立基线的首次轮询，无需发送请求。
   */
  begin(now: number): PollingWindow | null {
    if (!this.initialized) {
      this.initialized = true;
      if (!this.options.emitExisting) {
        this.lastCheck = now;
        return null;
      }
      this.lastCheck = now - this.options.initialLookbackMs;
    }

    const floor = now - this.options.maxLookbackMs;
    const since = Math.max(this.lastCheck - this.options.overlapMs, floor);

    return {
      since,
      sinceIso: new Date(since).toISOString(),
      previous: this.lastCheck,
    };
  }

  /** 本轮所有请求成功后再推进水位线。 */
  commit(now: number): void {
    this.lastCheck = now;
  }

  /** 返回 true 表示该事件第一次出现。 */
  markSeen(key: string): boolean {
    return this.seen.addIfNew(key);
  }

  hasSeen(key: string): boolean {
    return this.seen.has(key);
  }

  reset(now = Date.now()): void {
    this.initialized = false;
    this.lastCheck = now;
    this.seen.clear();
  }
}

export function reportHandlerError(
  logger: LoggerLike,
  onError: ((error: unknown) => void) | undefined,
  message: string,
  error: unknown
): void {
  logger.error(message, error);
  if (!onError) return;

  try {
    onError(error);
  } catch (hookError) {
    logger.error('onError hook failed', hookError);
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
  return Math.trunc(value);
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number`);
  }
  return Math.trunc(value);
}
