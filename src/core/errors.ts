import axios from 'axios';

export interface GitCodeApiErrorOptions {
  status?: number;
  method?: string;
  url?: string;
  code?: number;
  codeName?: string;
  traceId?: string;
  payload?: unknown;
  retryAfterMs?: number;
}

/**
 * GitCode API 错误。
 *
 * 只保留定位问题所需的字段（状态码、错误码、trace_id、响应体），不会携带
 * 请求头，因此 token 不会通过错误对象泄漏到日志中。
 */
export class GitCodeApiError extends Error {
  readonly status?: number;
  readonly method?: string;
  readonly url?: string;
  readonly code?: number;
  readonly codeName?: string;
  readonly traceId?: string;
  readonly payload?: unknown;
  readonly retryAfterMs?: number;

  constructor(message: string, options: GitCodeApiErrorOptions = {}) {
    super(message);
    this.name = 'GitCodeApiError';
    this.status = options.status;
    this.method = options.method;
    this.url = options.url;
    this.code = options.code;
    this.codeName = options.codeName;
    this.traceId = options.traceId;
    this.payload = options.payload;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isGitCodeApiError(error: unknown): error is GitCodeApiError {
  return error instanceof GitCodeApiError;
}

export function toGitCodeApiError(error: unknown): GitCodeApiError {
  if (isGitCodeApiError(error)) return error;

  if (axios.isAxiosError(error)) {
    const response = error.response;
    const payload = sanitizePayload(response?.data);
    const record = asRecord(payload);
    const status = response?.status;
    const method = (error.config?.method ?? 'GET').toUpperCase();
    const url = error.config?.url ?? '';
    const apiMessage = readString(record, 'error_message') ?? readString(record, 'message');
    const detail = truncate(apiMessage ?? error.message, 2_000);
    const prefix = status ? `GitCode API ${status}` : 'GitCode API request failed';
    const message = `${prefix} ${method} ${url}: ${detail}`.replace(/\s+/g, ' ').trim();

    return new GitCodeApiError(message, {
      status,
      method,
      url,
      code: readNumber(record, 'error_code'),
      codeName: readString(record, 'error_code_name'),
      traceId: readString(record, 'trace_id'),
      payload,
      retryAfterMs: parseRetryAfter(response?.headers),
    });
  }

  if (error instanceof Error) {
    return new GitCodeApiError(error.message);
  }

  return new GitCodeApiError(String(error));
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 网络错误（无状态码）、限流与 5xx 可安全重试。 */
export function isRetryableError(error: GitCodeApiError): boolean {
  if (error.status === undefined) return true;
  return RETRYABLE_STATUS.has(error.status);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function sanitizePayload(value: unknown): unknown {
  if (typeof value === 'string') return truncate(value, 4_000);
  return value;
}

function parseRetryAfter(headers: unknown): number | undefined {
  const raw = readHeader(headers, 'retry-after');
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, raw * 1_000);
  }
  if (typeof raw === 'string' && raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

function readHeader(headers: unknown, name: string): unknown {
  if (typeof headers !== 'object' || headers === null) return undefined;

  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    try {
      return (getter as (headerName: string) => unknown).call(headers, name);
    } catch {
      return undefined;
    }
  }

  const record = headers as Record<string, unknown>;
  return record[name] ?? record[name.toLowerCase()];
}
