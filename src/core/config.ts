import type { GitCodeConfig, Repository } from '../types';
import { VERSION } from '../version';

export const DEFAULT_BASE_URL = 'https://api.gitcode.com/api/v5';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 500;
export const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;
export const DEFAULT_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_SOCKETS = 50;

export interface ResolvedGitCodeConfig {
  token: string;
  baseUrl: string;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  userAgent: string;
  keepAlive: boolean;
  maxSockets: number;
  headers: Record<string, string>;
}

/**
 * 校验并归一化 SDK 配置。
 *
 * - baseUrl 末尾的 `/` 会被移除；
 * - 只传主机名（如 https://api.gitcode.com）时会自动补上 `/api/v5`；
 * - token 不允许为空。
 */
export function resolveGitCodeConfig(config: GitCodeConfig): ResolvedGitCodeConfig {
  if (!config || typeof config !== 'object') {
    throw new TypeError('GitCode config is required');
  }

  const token = typeof config.token === 'string' ? config.token.trim() : '';
  if (!token) {
    throw new TypeError('GitCode token is required (config.token)');
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);

  return {
    token,
    baseUrl,
    timeoutMs: positiveInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    retries: nonNegativeInteger(config.retries, DEFAULT_RETRIES, 'retries'),
    retryDelayMs: nonNegativeInteger(config.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 'retryDelayMs'),
    maxRetryDelayMs: nonNegativeInteger(
      config.maxRetryDelayMs,
      DEFAULT_MAX_RETRY_DELAY_MS,
      'maxRetryDelayMs'
    ),
    userAgent:
      config.userAgent?.trim() ||
      `gitcode-sdk/${VERSION} node/${process.version.replace(/^v/, '')}`,
    keepAlive: config.keepAlive !== false,
    maxSockets: positiveInteger(config.maxSockets, DEFAULT_MAX_SOCKETS, 'maxSockets'),
    headers: { ...(config.headers ?? {}) },
  };
}

/**
 * 校验仓库信息并去除首尾空格。owner/repo 中不允许出现 `/`，避免拼接出错误的 URL。
 */
export function normalizeRepository(repo: Repository): Repository {
  if (!repo || typeof repo !== 'object') {
    throw new TypeError('Repository is required');
  }
  const owner = typeof repo.owner === 'string' ? repo.owner.trim() : '';
  const name = typeof repo.repo === 'string' ? repo.repo.trim() : '';

  if (!owner || !name) {
    throw new TypeError('Repository must include non-empty owner and repo');
  }
  if (owner.includes('/') || name.includes('/')) {
    throw new TypeError('Repository owner and repo must not contain "/"');
  }

  return { owner, repo: name };
}

export function normalizeBaseUrl(input?: string): string {
  const raw = (input?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`Invalid GitCode baseUrl: ${raw}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`GitCode baseUrl must use http or https: ${raw}`);
  }

  // 只传了主机名时补全 API 版本前缀，减少使用者的配置错误。
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/api/v5';
  }
  url.hash = '';

  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
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
