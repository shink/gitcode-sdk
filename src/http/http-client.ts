import http from 'node:http';
import https from 'node:https';
import axios, { type AxiosInstance } from 'axios';

import { resolveGitCodeConfig, type ResolvedGitCodeConfig } from '../core/config';
import { GitCodeApiError, isRetryableError, toGitCodeApiError } from '../core/errors';
import type { GitCodeConfig, PaginationOptions, QueryParams, RequestOptions } from '../types';
import { sleep } from '../utils/concurrency';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface PageRequestOptions extends PaginationOptions, RequestOptions {}

/**
 * GitCode HTTP 客户端。
 *
 * 职责：
 * - Bearer Token 认证与基础请求头；
 * - 超时、连接复用、可重试错误的指数退避；
 * - 统一错误映射为 GitCodeApiError；
 * - 自动分页（GitCode 没有 Link 响应头，只能按 per_page 是否取满判断）。
 */
export class HttpClient {
  private readonly client: AxiosInstance;
  private readonly config: ResolvedGitCodeConfig;
  private readonly httpAgent?: http.Agent;
  private readonly httpsAgent?: https.Agent;

  constructor(config: GitCodeConfig) {
    this.config = resolveGitCodeConfig(config);

    if (this.config.keepAlive) {
      this.httpAgent = new http.Agent({
        keepAlive: true,
        maxSockets: this.config.maxSockets,
      });
      this.httpsAgent = new https.Agent({
        keepAlive: true,
        maxSockets: this.config.maxSockets,
      });
    }

    this.client = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeoutMs,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': this.config.userAgent,
        ...this.config.headers,
      },
    });
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  async get<T>(url: string, params?: QueryParams, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', url, { params }, options);
  }

  async post<T, B = unknown>(url: string, body?: B, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', url, { data: body }, options);
  }

  async patch<T, B = unknown>(url: string, body?: B, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PATCH', url, { data: body }, options);
  }

  async put<T, B = unknown>(url: string, body?: B, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PUT', url, { data: body }, options);
  }

  async delete<T>(url: string, params?: QueryParams, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', url, { params }, options);
  }

  /**
   * 自动翻页获取全部数据。
   *
   * GitCode 的 per_page 上限为 100，且部分接口会忽略 per_page 直接返回全量。
   * 这里同时处理两种情况：返回条数大于 per_page 时视为单页全量；连续两页
   * 首条记录相同时停止，避免服务端忽略分页参数导致死循环。
   */
  async getAll<T>(
    url: string,
    params: QueryParams = {},
    options: PageRequestOptions = {}
  ): Promise<T[]> {
    const perPage = clampInteger(options.perPage ?? 100, 1, 100);
    const maxPages = clampInteger(options.maxPages ?? 50, 1, 1_000);
    const startPage = clampInteger(options.startPage ?? 1, 1, Number.MAX_SAFE_INTEGER);

    const items: T[] = [];
    let previousFirstKey: string | undefined;

    for (let offset = 0; offset < maxPages; offset += 1) {
      const batch = await this.get<T[]>(
        url,
        { ...params, page: startPage + offset, per_page: perPage },
        options
      );

      if (!Array.isArray(batch)) {
        throw new GitCodeApiError(`Expected an array response from ${url}`, { url });
      }
      if (batch.length === 0) break;

      const firstKey = getItemKey(batch[0]);
      if (firstKey !== undefined && firstKey === previousFirstKey) break;

      items.push(...batch);
      previousFirstKey = firstKey;

      // 服务端忽略 per_page 时会一次性返回全部数据，继续翻页只会重复。
      if (batch.length > perPage) break;
      if (batch.length < perPage) break;
    }

    return items;
  }

  /** 释放 keep-alive 连接。调用后该实例不应继续使用。 */
  close(): void {
    this.httpAgent?.destroy();
    this.httpsAgent?.destroy();
  }

  private async request<T>(
    method: HttpMethod,
    url: string,
    config: { params?: QueryParams; data?: unknown },
    options: RequestOptions
  ): Promise<T> {
    const requestedRetries = options.retries ?? (method === 'POST' ? 0 : this.config.retries);
    const retries = Number.isFinite(requestedRetries)
      ? Math.max(0, Math.trunc(requestedRetries))
      : 0;
    const maxAttempts = retries + 1;
    const timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : this.config.timeoutMs;
    let attempt = 0;

    for (;;) {
      try {
        const response = await this.client.request<T>({
          method,
          url,
          params: config.params,
          data: config.data,
          timeout: timeoutMs,
          signal: options.signal,
          headers: options.headers,
        });
        return response.data;
      } catch (error) {
        const apiError = toGitCodeApiError(error);
        attempt += 1;

        if (attempt >= maxAttempts || options.signal?.aborted || !isRetryableError(apiError)) {
          throw apiError;
        }

        const baseDelay = apiError.retryAfterMs ?? this.config.retryDelayMs * 2 ** (attempt - 1);
        const delay = Math.min(this.config.maxRetryDelayMs, Math.max(0, baseDelay));
        await sleep(delay);
        if (options.signal?.aborted) throw apiError;
      }
    }
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function getItemKey(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const record = item as Record<string, unknown>;

  for (const key of ['id', 'number', 'sha', 'name'] as const) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') {
      return `${key}:${value}`;
    }
  }
  return undefined;
}
