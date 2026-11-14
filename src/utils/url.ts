import type { Repository } from '../types';

/** 对 URL 路径片段做编码，并拒绝空值。 */
export function encodePathSegment(value: string | number): string {
  const text = String(value).trim();
  if (!text) {
    throw new TypeError('URL path segment must not be empty');
  }
  return encodeURIComponent(text);
}

/**
 * 构造 /repos/:owner/:repo/... 路径。所有片段都会被 URL 编码，避免仓库名、
 * 标签名中的特殊字符破坏请求路径。
 */
export function repoPath(repo: Repository, ...segments: Array<string | number>): string {
  const base = `/repos/${encodePathSegment(repo.owner)}/${encodePathSegment(repo.repo)}`;
  if (segments.length === 0) return base;
  return `${base}/${segments.map(encodePathSegment).join('/')}`;
}
