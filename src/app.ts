import { DEFAULT_INTERVAL_MS, normalizeRepository } from './core/config';
import { HttpClient } from './http/http-client';
import { IssueEventHandler } from './listeners/issue-listener';
import { PullRequestEventHandler } from './listeners/pr-listener';
import { getLogger, type LoggerLike } from './logger';
import type {
  EventCallback,
  EventCallbackOf,
  EventContext,
  EventContextOf,
  EventType,
  GitCodeAppOptions,
  GitCodeConfig,
  Repository,
} from './types';

interface ResolvedAppOptions {
  intervalMs: number;
  autoStart: boolean;
  emitExisting: boolean;
  initialLookbackMs: number;
  overlapMs: number;
  maxLookbackMs: number;
  maxPages: number;
  maxConcurrentRequests: number;
  unref: boolean;
  clock: () => number;
}

/**
 * GitCodeApp 负责事件轮询与回调分发。
 *
 * 注意：
 * - 默认仍会在构造时自动开始轮询（兼容 1.0），但推荐传 autoStart:false 后显式 start()；
 * - stop() 只停止定时器，不会清空已注册的监听器；dispose() 才会释放资源；
 * - 回调并行执行，单个回调失败不会影响其他回调。
 */
export class GitCodeApp {
  private readonly http: HttpClient;
  private readonly repo: Repository;
  private readonly intervalMs: number;
  private readonly options: ResolvedAppOptions;
  private readonly logger: LoggerLike;
  private readonly log: LoggerLike;
  private readonly issueHandler: IssueEventHandler;
  private readonly prHandler: PullRequestEventHandler;
  private readonly callbacks = new Map<EventType, Set<EventCallback>>();
  private readonly errorHandlers = new Set<(error: unknown) => void>();
  private readonly ownsHttpClient: boolean;

  private timer?: NodeJS.Timeout;
  private running = false;
  private polling = false;
  private generation = 0;

  constructor(config: GitCodeConfig, repo: Repository, options: number | GitCodeAppOptions = {}) {
    this.options = resolveAppOptions(options);
    this.intervalMs = this.options.intervalMs;
    this.repo = normalizeRepository(repo);
    this.logger = resolveLogger(options);
    this.log = this.logger.child(`${this.repo.owner}/${this.repo.repo}`);

    const injectedHttpClient = getHttpClientOption(options);
    if (injectedHttpClient) {
      this.http = injectedHttpClient;
      this.ownsHttpClient = false;
    } else {
      this.http = new HttpClient(config);
      this.ownsHttpClient = true;
    }

    const handlerOptions = {
      intervalMs: this.intervalMs,
      overlapMs: this.options.overlapMs,
      initialLookbackMs: this.options.initialLookbackMs,
      maxLookbackMs: this.options.maxLookbackMs,
      emitExisting: this.options.emitExisting,
      maxPages: this.options.maxPages,
      maxConcurrentRequests: this.options.maxConcurrentRequests,
      logger: this.logger,
      clock: this.options.clock,
      onError: (error: unknown) => this.notifyError(error),
    };

    this.issueHandler = new IssueEventHandler(this.http, this.repo, handlerOptions);
    this.prHandler = new PullRequestEventHandler(this.http, this.repo, handlerOptions);

    const onError = getOnErrorOption(options);
    if (onError) this.errorHandlers.add(onError);

    if (this.options.autoStart) this.start();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get interval(): number {
    return this.intervalMs;
  }

  /** 注册事件监听器。同一个函数重复注册会自动去重。 */
  on<E extends EventType>(event: E, callback: EventCallbackOf<E>): this {
    if (typeof callback !== 'function') {
      throw new TypeError('Event callback must be a function');
    }

    let listeners = this.callbacks.get(event);
    if (!listeners) {
      listeners = new Set();
      this.callbacks.set(event, listeners);
    }
    listeners.add(callback as unknown as EventCallback);
    return this;
  }

  /** 注册只执行一次的监听器。 */
  once<E extends EventType>(event: E, callback: EventCallbackOf<E>): this {
    const wrapped: EventCallbackOf<E> = (context: EventContextOf<E>) => {
      this.off(event, wrapped);
      return callback(context);
    };
    return this.on(event, wrapped);
  }

  /** 移除指定回调；不传 callback 时移除该事件的全部回调。 */
  off<E extends EventType>(event: E, callback?: EventCallbackOf<E>): this {
    const listeners = this.callbacks.get(event);
    if (!listeners) return this;

    if (callback) {
      listeners.delete(callback as unknown as EventCallback);
    } else {
      listeners.clear();
    }

    if (listeners.size === 0) this.callbacks.delete(event);
    return this;
  }

  removeAllListeners(event?: EventType): this {
    if (event) {
      this.callbacks.delete(event);
    } else {
      this.callbacks.clear();
    }
    return this;
  }

  /** 注册错误回调（事件监听器异常、轮询异常都会触发）。 */
  onError(handler: (error: unknown) => void): this {
    if (typeof handler !== 'function') {
      throw new TypeError('Error handler must be a function');
    }
    this.errorHandlers.add(handler);
    return this;
  }

  /**
   * 开始/恢复轮询。重复调用是幂等的。
   * 首次轮询会在 intervalMs 之后执行；需要立即执行请调用 pollNow()。
   */
  start(): this {
    if (this.running) return this;

    this.running = true;
    const generation = ++this.generation;
    this.log.debug('Polling started', { intervalMs: this.intervalMs });
    this.schedule(generation, this.intervalMs);
    return this;
  }

  /** 停止轮询，但保留监听器；需要重新开始时调用 start()。 */
  stop(): this {
    const wasRunning = this.running;
    this.running = false;
    this.generation += 1;
    this.clearTimer();
    if (wasRunning) this.log.debug('Polling stopped');
    return this;
  }

  /** 立即执行一轮轮询（可用于测试或手动触发）。 */
  async pollNow(): Promise<void> {
    if (this.polling) {
      this.log.warn('A poll is already in progress; skipping manual poll');
      return;
    }

    this.polling = true;
    const generation = this.generation;
    try {
      await this.pollOnce(generation);
    } catch (error) {
      this.reportError(error);
    } finally {
      this.polling = false;
    }
  }

  /** 停止轮询、清空监听器，并释放 App 自己创建的 HTTP 连接。 */
  dispose(): void {
    this.stop();
    this.callbacks.clear();
    this.errorHandlers.clear();
    if (this.ownsHttpClient) this.http.close();
  }

  getHttpClient(): HttpClient {
    return this.http;
  }

  getRepo(): Repository {
    return this.repo;
  }

  private schedule(generation: number, delayMs: number): void {
    if (!this.running || generation !== this.generation) return;

    this.timer = setTimeout(() => {
      void this.runScheduled(generation);
    }, delayMs);

    if (this.options.unref) this.timer.unref();
  }

  private async runScheduled(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;

    if (this.polling) {
      this.log.warn('Previous poll is still running; skipping this tick');
      this.schedule(generation, this.intervalMs);
      return;
    }

    this.polling = true;
    try {
      await this.pollOnce(generation);
    } catch (error) {
      this.reportError(error);
    } finally {
      this.polling = false;
      if (this.running && generation === this.generation) {
        this.schedule(generation, this.intervalMs);
      }
    }
  }

  private async pollOnce(generation: number): Promise<void> {
    const eventTypes = new Set(this.callbacks.keys());
    if (eventTypes.size === 0) {
      this.log.debug('No listeners registered; skipping poll');
      return;
    }

    const now = this.options.clock();
    this.log.debug('Poll started', { eventTypes: [...eventTypes] });

    const [issueResults, prResults] = await Promise.all([
      this.issueHandler.checkEvents(now, eventTypes).catch((error: unknown) => {
        this.reportError(error);
        return [];
      }),
      this.prHandler.checkEvents(now, eventTypes).catch((error: unknown) => {
        this.reportError(error);
        return [];
      }),
    ]);

    if (generation !== this.generation) {
      this.log.debug('Poll result discarded after stop/restart');
      return;
    }

    for (const result of [...issueResults, ...prResults]) {
      if (generation !== this.generation) {
        this.log.debug('Remaining poll results discarded after stop/restart');
        return;
      }
      await this.dispatch(result.event, result.context);
    }

    this.log.debug('Poll completed', {
      issueEvents: issueResults.length,
      prEvents: prResults.length,
    });
  }

  private async dispatch(event: EventType, context: EventContext): Promise<void> {
    const listeners = this.callbacks.get(event);
    if (!listeners || listeners.size === 0) return;

    const settled = await Promise.allSettled(
      [...listeners].map(async callback => {
        await callback(context);
      })
    );

    for (const result of settled) {
      if (result.status === 'rejected') {
        this.log.error(`Listener for "${event}" failed`, result.reason);
        this.notifyError(result.reason);
      }
    }
  }

  private notifyError(error: unknown): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch (hookError) {
        this.log.error('Error handler failed', hookError);
      }
    }
  }

  private reportError(error: unknown): void {
    this.log.error('Unhandled polling error', error);
    this.notifyError(error);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function resolveAppOptions(input: number | GitCodeAppOptions): ResolvedAppOptions {
  const options = typeof input === 'number' ? { intervalMs: input } : (input ?? {});
  const intervalMs = positiveInteger(
    options.intervalMs ?? options.interval,
    DEFAULT_INTERVAL_MS,
    'intervalMs'
  );

  return {
    intervalMs,
    autoStart: options.autoStart !== false,
    emitExisting: options.emitExisting === true,
    initialLookbackMs: nonNegativeInteger(
      options.initialLookbackMs,
      intervalMs,
      'initialLookbackMs'
    ),
    overlapMs: nonNegativeInteger(options.overlapMs, Math.min(5_000, intervalMs), 'overlapMs'),
    maxLookbackMs: positiveInteger(
      options.maxLookbackMs,
      Math.max(intervalMs * 10, 5 * 60_000),
      'maxLookbackMs'
    ),
    maxPages: positiveInteger(options.maxPages, 20, 'maxPages'),
    maxConcurrentRequests: positiveInteger(
      options.maxConcurrentRequests,
      5,
      'maxConcurrentRequests'
    ),
    unref: options.unref === true,
    clock: options.clock ?? (() => Date.now()),
  };
}

function resolveLogger(input: number | GitCodeAppOptions): LoggerLike {
  if (typeof input === 'number' || !input) return getLogger();
  return input.logger ?? getLogger();
}

function getHttpClientOption(input: number | GitCodeAppOptions): HttpClient | undefined {
  return typeof input === 'number' || !input ? undefined : input.httpClient;
}

function getOnErrorOption(
  input: number | GitCodeAppOptions
): ((error: unknown) => void) | undefined {
  return typeof input === 'number' || !input ? undefined : input.onError;
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
