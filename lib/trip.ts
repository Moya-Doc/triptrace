import type { ItineraryDay, ItineraryItem, TripNote } from "./types";

// 旅行中的记录和"计划 vs 实际"的对比，界面和写游记共用。
// 记录的键是"第几天|条目名"：TT 在路上改了时间、换了顺序，记录还跟着原来的地方；换成了别的地方，就是新的一条

// 行程里没有的地方（对话里说的"路过一家茶馆"）：记在那一天的"计划外"
export const UNPLANNED = "计划外";

export function noteKey(dayIndex: number, title: string) {
  return `${dayIndex}|${title}`;
}

export function hasNote(n: TripNote | undefined) {
  return Boolean(n && (n.text.trim() || n.photos.length));
}

// 景点和用餐（时间轴上能写记录的条目）
export function stopsOf(d: ItineraryDay) {
  return d.items.filter((x) => x.kind === "place" || x.kind === "free");
}

export type DayDiff = {
  // 出发后新加的（原计划里没有）
  added: Set<string>;
  // 原计划里有、现在没有了
  removed: ItineraryItem[];
  // 时间变了：条目名 → 原计划的开始时间
  moved: Map<string, string>;
};

// 和出发时的计划比：按条目名对应；没有基准（还没出发）或基准里没有这一天，就当作没有变化
export function diffDay(day: ItineraryDay, base: ItineraryDay | undefined): DayDiff {
  const diff: DayDiff = { added: new Set(), removed: [], moved: new Map() };
  if (!base) return diff;
  const before = new Map(stopsOf(base).map((x) => [x.title, x]));
  const now = new Set(stopsOf(day).map((x) => x.title));
  for (const x of stopsOf(day)) {
    const old = before.get(x.title);
    if (!old) diff.added.add(x.title);
    else if (old.start && x.start && old.start !== x.start) diff.moved.set(x.title, old.start);
  }
  diff.removed = stopsOf(base).filter((x) => !now.has(x.title));
  return diff;
}
