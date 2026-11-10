import type { DayLoad, ItineraryDay } from "./types";

// 每天的活动时间段和负荷。服务端排时间、界面画负荷条都用这里，保证两边的判断一致。
// 活动时间段默认 09:00–21:00（12 小时），用户可以对 TT 说"第一天 10 点再出门"来改。
// 负荷按"路上 + 游玩"占活动时间的比例判断，和负荷条上看到的长度一致：
// 85% 以下刚好，85%–100% 偏紧，超过 100% 太满。路上时间超过活动时间的 25% 另外标"路上久"

export const DEFAULT_WINDOW = { start: "09:00", end: "21:00" };

export function toMinutes(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function toClock(minutes: number) {
  const m = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function dayWindow(d: Pick<ItineraryDay, "window">) {
  const w = d.window ?? DEFAULT_WINDOW;
  const minutes = toMinutes(w.end) - toMinutes(w.start);
  return { ...w, minutes: minutes > 0 ? minutes : 12 * 60 };
}

export function dayLoad(transit: number, play: number, windowMinutes = 12 * 60): DayLoad {
  const used = transit + play;
  if (used > windowMinutes) return "overloaded";
  if (used >= windowMinutes * 0.85) return "tight";
  return "ok";
}

export function transitHeavy(transit: number, windowMinutes = 12 * 60) {
  return transit >= windowMinutes * 0.25;
}
