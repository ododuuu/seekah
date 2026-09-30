/** SPEC §77／D109：工作台、MCP `index_status` 與 `GET /api/index-status` 的清單預覽上限。 */
export const STATUS_LIST_PREVIEW_LIMIT = 100;

export interface StatusListPreview<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

export function previewStatusList<T>(
  items: readonly T[] | null | undefined,
  limit = STATUS_LIST_PREVIEW_LIMIT,
): StatusListPreview<T> {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const truncated = total > limit;
  return {
    items: truncated ? list.slice(0, limit) : [...list],
    total,
    truncated,
  };
}

/** 截斷時的固定文案；未截斷時呼叫端自行顯示筆數。 */
export function formatTruncatedListNotice(total: number, shown: number): string {
  return `共 ${total} 筆，只列前 ${shown} 筆`;
}
