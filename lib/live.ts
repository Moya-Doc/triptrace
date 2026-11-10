import { relayoutDay } from "./itinerary";
import { toMinutes } from "./load";
import type { Itinerary, ItineraryDay, ItineraryItem } from "./types";

// 旅行中的实时调整。规则：
// - 用户告诉 TT"现在几点、刚到哪"：这一天在它之前的安排算"已经去过"，冻结（固定在原来的时间、标记完成）；
//   它本身从现在开始；后面的按路上时间自动顺延
// - 已经过去的日子、今天已经去过的项，TT 都不能再改
// 排时间、查路线还是用规划时的同一套（relayoutDay），这里只是在调用前把过去的固定住

// arrived：几点到的"at"。默认等于 now（刚到）；在一个地方已经待了一会儿时更早（10:00 到的，现在 12:00 还在）
export type LiveState = { day: number; now: string; at: string; arrived?: string };

// 几点到的：没给、格式不对、或者晚于现在，就当作刚到
export function arrivedAt(s: LiveState) {
  return s.arrived && /^\d{2}:\d{2}$/.test(s.arrived) && toMinutes(s.arrived) <= toMinutes(s.now) ? s.arrived : s.now;
}

// "刚到「武侯祠」" / "在「武侯祠」（10:00 到的）"
export function whereText(s: LiveState) {
  const arrived = arrivedAt(s);
  return arrived === s.now ? `刚到「${s.at}」` : `在「${s.at}」（${arrived} 到的）`;
}

export function liveContext(s: LiveState) {
  return [
    `用户正在旅行中。现在是第 ${s.day + 1} 天 ${s.now}，${whereText(s)}。`,
    `这一天在「${s.at}」之前的安排已经去过了，不能再改；之前的日子也不能改。`,
    `只调整「${s.at}」以及之后的安排（今天剩下的和以后几天）。`,
    `用户人在路上，回复要短，先给结论；需要用户决定时只问一个问题。`,
  ].join("");
}

// 冻结过去、从到达时间开始：返回这一天新的景点 / 用餐顺序（交给 relayoutDay 重排）
export function freezeOrder(day: ItineraryDay, at: string, arrived: string) {
  const core = day.items.filter((x) => x.kind === "place" || x.kind === "free");
  const idx = core.findIndex((x) => x.title === at);
  if (idx < 0) return null;
  const frozen = new Set(core.slice(0, idx).map((x) => x.title));
  const order: ItineraryItem[] = core.map((x, i) =>
    i < idx ? { ...x, pinned: Boolean(x.start), done: true } : i === idx ? { ...x, start: arrived, pinned: true } : x,
  );
  return { order, frozen };
}

// 同步：按"在哪、几点到的"重排今天：现在这一项从到达时间开始，后面的顺延。返回新的行程，以及到得比计划早了 / 晚了多少分钟
export async function syncToNow(itinerary: Itinerary, s: LiveState, transport: string | null) {
  const day = itinerary.days.find((d) => d.index === s.day);
  if (!day) throw new Error("找不到这一天");
  const arrived = arrivedAt(s);
  const frozen = freezeOrder(day, s.at, arrived);
  if (!frozen) throw new Error(`第 ${s.day + 1} 天没有"${s.at}"`);
  const planned = day.items.find((x) => x.title === s.at)?.start ?? null;
  const late = planned ? toMinutes(arrived) - toMinutes(planned) : 0;
  const updated = await relayoutDay(day, frozen.order, { transport });
  // 冻结的那几项保持"已完成"；它们和现在这一项是已经发生的事，不标冲突（比如提前到了）
  const items = updated.items.map((x) =>
    frozen.frozen.has(x.title) ? { ...x, done: true, conflict: false } : x.title === s.at ? { ...x, conflict: false } : x,
  );
  const next = { ...itinerary, days: itinerary.days.map((d) => (d.index === s.day ? { ...updated, items } : d)) };
  return { itinerary: next, late, frozen: frozen.frozen, before: day, after: { ...updated, items } };
}

// 一句话说明同步的结果（规则生成，不用 LLM）：早晚多少、后面几项的新时间、开放时间的问题
export function describeSync(s: LiveState, late: number, after: ItineraryDay) {
  const core = after.items.filter((x) => x.kind === "place" || x.kind === "free");
  const idx = core.findIndex((x) => x.title === s.at);
  const rest = core.slice(idx + 1);
  const lead =
    late > 5 ? `比计划晚了 ${late} 分钟` : late < -5 ? `比计划早了 ${-late} 分钟` : "和计划差不多";
  const arrived = arrivedAt(s);
  const where = arrived === s.now ? `现在 ${s.now} 到「${s.at}」` : ` ${arrived} 到「${s.at}」（现在 ${s.now}）`;
  const lines = [`好，已按${where}重排了今天：${lead}。`];
  if (rest.length)
    lines.push(`后面的安排：${rest.map((x) => `${x.start} ${x.venue ? `${x.title}（${x.venue.name}）` : x.title}`).join("，")}。`);
  const issues = core.slice(idx).filter((x) => x.hoursIssue);
  if (issues.length) lines.push(`⚠ ${issues.map((x) => `「${x.title}」${x.hoursIssue}`).join("；")}。要不要调整？`);
  return lines.join("\n");
}

// TT 改完之后再整理一次：已经去过的排在最前面、保持原样；剩下的第一项从"现在"开始（比如把正在逛的地方换成了别处，
// 新地方不能排到已经过去的时间里），后面的按路上时间顺延
export async function refreeze(itinerary: Itinerary, s: LiveState, frozen: Set<string>, transport: string | null) {
  const day = itinerary.days.find((d) => d.index === s.day);
  if (!day) return itinerary;
  const core = day.items.filter((x) => x.kind === "place" || x.kind === "free");
  const past = core.filter((x) => frozen.has(x.title));
  const rest = core.filter((x) => !frozen.has(x.title));
  if (!rest.length) return itinerary;
  const first = rest[0];
  // 正在逛的这一项从到达时间算（已经在这待了一会儿）；换成了别处，就从现在开始
  const floor = first.title === s.at ? arrivedAt(s) : s.now;
  if (!first.pinned || !first.start || toMinutes(first.start) < toMinutes(floor)) rest[0] = { ...first, start: floor, pinned: true };
  const updated = await relayoutDay(day, [...past, ...rest], { transport });
  const items = updated.items.map((x) =>
    frozen.has(x.title) ? { ...x, done: true, conflict: false } : x === updated.items.find((y) => y.title === rest[0].title) ? { ...x, conflict: false } : x,
  );
  return { ...itinerary, days: itinerary.days.map((d) => (d.index === s.day ? { ...updated, items } : d)) };
}
