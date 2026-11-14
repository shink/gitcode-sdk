import type { LabelsInput } from '../types';

/** 将 labels 统一转换成本 API 需要的逗号分隔字符串。 */
export function labelsToParam(labels?: LabelsInput): string | undefined {
  if (labels === undefined) return undefined;
  if (typeof labels === 'string') return labels;

  const values = labels.map(label => label.trim()).filter(Boolean);
  return values.length > 0 ? values.join(',') : undefined;
}
