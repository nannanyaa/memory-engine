/**
 * time.ts — 时间工具
 */
export function nowMs(): number {
  return Date.now();
}

/** 从消息事件取时间戳（无则用现在）。 */
export function eventTime(event: { timestamp?: number }): number {
  if (event.timestamp && Number.isFinite(event.timestamp)) return event.timestamp;
  return nowMs();
}

export function toISODate(tsMs: number): string {
  const d = new Date(tsMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
