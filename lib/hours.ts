import { toClock, toMinutes } from "./load";
import type { OpeningHours } from "./types";

export type { OpeningHours };

// 开放时间：来自高德地点详情的 open_time，用规则解析和核对（不靠 LLM）。
// 高德的写法有几种：
// - "09:00-18:00"
// - "07:30-17:00 08:00-16:30"：两段重叠，一般是旺季 / 淡季，不知道是哪一段，就按两段都满足的时间算（08:00-16:30）
// - "11:00-14:00 17:00-21:00"：两段不重叠，是分时段营业，落在任意一段里都行
// - "11:00-02:00"：跨过午夜
// - "24小时营业"
// - 写了"周一闭馆""周二至周日"的，那天不开
// 没有数据（null）就不核对，也不假装知道


const WEEK = "日一二三四五六";

export function parseHours(text: string | null | undefined): OpeningHours | null {
  if (!text) return null;
  const closedDays = new Set<number>();
  for (const m of text.matchAll(/周([一二三四五六日天])\s*(闭馆|休息|休馆|闭园|不开放|不营业)/g))
    closedDays.add(WEEK.indexOf(m[1] === "天" ? "日" : m[1]));
  const span = text.match(/周([一二三四五六日])\s*[至到-]\s*周([一二三四五六日])/);
  if (span) {
    // "周二至周日"开放 → 其余几天不开
    const from = WEEK.indexOf(span[1]);
    const to = WEEK.indexOf(span[2]);
    const open = new Set<number>();
    for (let d = from; ; d = (d + 1) % 7) {
      open.add(d);
      if (d === to) break;
    }
    for (let d = 0; d < 7; d++) if (!open.has(d)) closedDays.add(d);
  }

  // 全天开放：给足两天的范围，逛到半夜也不算关门
  if (/24\s*小时/.test(text)) return { text, ranges: [[0, 48 * 60]], closedDays: [...closedDays], seasonal: false };

  const raw: [number, number][] = [];
  for (const m of text.matchAll(/(\d{1,2}:\d{2})\s*[-~至到]\s*(次日)?\s*(\d{1,2}:\d{2})/g)) {
    const start = toMinutes(m[1]);
    let end = toMinutes(m[3]);
    if (m[2] || end <= start) end += 24 * 60;
    raw.push([start, end]);
  }
  if (!raw.length) return { text, ranges: null, closedDays: [...closedDays], seasonal: false };

  // 重叠的几段是不同季节的时间：取交集；不重叠的是分时段营业：都保留
  raw.sort((a, b) => a[0] - b[0]);
  const overlapping = raw.length > 1 && raw.every(([s, e], i) => raw.every(([s2, e2], j) => i === j || (s < e2 && s2 < e)));
  const ranges: [number, number][] = overlapping
    ? [[Math.max(...raw.map((r) => r[0])), Math.min(...raw.map((r) => r[1]))]]
    : raw;
  return { text, ranges, closedDays: [...closedDays], seasonal: overlapping };
}

export function formatRanges(h: OpeningHours) {
  if (!h.ranges) return h.text;
  if (h.ranges.length === 1 && h.ranges[0][0] === 0 && h.ranges[0][1] >= 24 * 60) return "24 小时开放";
  return h.ranges.map(([s, e]) => `${toClock(s)}–${e > 24 * 60 ? "次日 " : ""}${toClock(e % (24 * 60) || (e === 24 * 60 ? 24 * 60 : 0))}`).join("、");
}

// 排时间用：从 cursor 起，这一项最早什么时候能开始（还没开门就等到开门；上一段已经过了就等下一段）
export function earliestOpenStart(h: OpeningHours | null | undefined, cursor: number) {
  if (!h?.ranges) return cursor;
  const next = h.ranges.find(([, e]) => e > cursor);
  return next ? Math.max(cursor, next[0]) : cursor;
}

// 核对一次安排：开门前到、关门后才到、关门时还没逛完、当天不开放。返回问题描述，没问题返回 null
export function checkVisit(h: OpeningHours | null | undefined, date: string | null, start: number, minutes: number): string | null {
  if (!h) return null;
  if (date) {
    const weekday = new Date(`${date}T00:00:00`).getDay();
    if (h.closedDays.includes(weekday)) return `这天是周${WEEK[weekday]}，不开放（${h.text}）`;
  }
  if (!h.ranges) return null;
  const end = start + minutes;
  if (h.ranges.some(([s, e]) => start >= s && end <= e)) return null;
  const season = h.seasonal ? "，按淡季时间算" : "";
  const inside = h.ranges.find(([s, e]) => start >= s && start < e);
  if (inside) return `${toClock(inside[1])} 就关门了${season}，按现在的安排只能待 ${inside[1] - start} 分钟`;
  const later = h.ranges.find(([s]) => s > start);
  if (later && later[0] < end) return `${toClock(later[0])} 才开门${season}，到早了`;
  if (later) return `这个时段不营业，${toClock(later[0])} 才开门（营业 ${formatRanges(h)}）`;
  return `到的时候已经关门了（开放 ${formatRanges(h)}${season}）`;
}
