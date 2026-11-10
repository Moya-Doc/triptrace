import type { ItineraryItem, LegMode } from "./types";

// 同城交通段的显示文字（时间轴、单日详情、地图连线上的标签共用）。
// 早期生成的行程没有记录交通方式，都是自驾

export const MODE_LABEL: Record<LegMode, string> = {
  walk: "步行",
  transit: "公交地铁",
  taxi: "打车",
  drive: "自驾",
};

export const MODE_EMOJI: Record<LegMode, string> = {
  walk: "🚶",
  transit: "🚇",
  taxi: "🚕",
  drive: "🚗",
};

export function legMode(x: ItineraryItem): LegMode {
  return x.mode ?? "drive";
}

export function formatDistance(m: number | null | undefined) {
  if (m == null || !Number.isFinite(m)) return null;
  return m < 1000 ? `${Math.round(m)} 米` : `${(m / 1000).toFixed(1)} 公里`;
}

// "地铁2号线 · 18 分钟 · 4.4 公里"
export function legText(x: ItineraryItem) {
  const mode = legMode(x);
  const legacyKm = x.via?.match(/约 ([\d.]+ 公里)/)?.[1] ?? null;
  const distance = formatDistance(x.distanceM) ?? legacyKm;
  const name = mode === "transit" && x.via ? x.via : MODE_LABEL[mode];
  return [name, `${x.minutes} 分钟`, distance].filter(Boolean).join(" · ");
}
