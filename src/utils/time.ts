import type { DateInput } from '../types';

/** 将 GitCode 返回的日期/时间戳安全转换为毫秒；空字符串与非法值返回 null。 */
export function toTimestamp(value: DateInput | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** 将 DateInput 转换为 ISO 8601 UTC 字符串（GitCode 的 since/created_after 参数）。 */
export function toIsoDate(value: DateInput | null | undefined): string | undefined {
  const ms = toTimestamp(value);
  return ms === null ? undefined : new Date(ms).toISOString();
}

export function isAfter(value: DateInput | null | undefined, sinceMs: number): boolean {
  const ms = toTimestamp(value);
  return ms !== null && ms > sinceMs;
}
