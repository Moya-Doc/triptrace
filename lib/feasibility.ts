import { geocode, transitBetween } from "./amap";
import type { Constraints, GeoPoint, RouteLeg, RoutePlan } from "./types";

// 流程二：可行性检查。全部由代码 + 高德完成，"赶不赶"由规则判断，不让 LLM 凭感觉说。
// 1. 按顺序定位每个城市：出发地 → 要去的城市 →（没说返程地时，假设原路返回出发地）
// 2. 相邻两站之间，查公共交通（含高铁）的门到门时间
// 3. 转场时间 ÷ 可活动时间（每天按 12 小时）→ 判断宽松 / 偏紧 / 超载

const ACTIVE_HOURS_PER_DAY = 12;
const TIGHT_SHARE = 0.15;
const OVERLOADED_SHARE = 0.25;

// 少于两站时没有路线可算，返回 null
export async function checkFeasibility(c: Constraints): Promise<RoutePlan | null> {
  const names = [...c.cities];
  if (c.origin && c.origin !== names[0]) names.unshift(c.origin);
  const returnAssumed = Boolean(c.origin) && names.length >= 2 && names[names.length - 1] !== c.origin;
  if (returnAssumed) names.push(c.origin!);
  if (names.length < 2) return null;

  const located = await Promise.all(names.map((n) => geocode(n)));
  const unresolved = [...new Set(names.filter((_, i) => !located[i]))];
  // 只有返程地真的定位到了，最后一段才是"假设的返程"
  const returnLocated = returnAssumed && located[located.length - 1] !== null;
  const stops = located.filter((p): p is GeoPoint & { city: string } => p !== null);

  const legs: RouteLeg[] = await Promise.all(
    stops.slice(1).map(async (to, i) => {
      const from = stops[i];
      const t = await transitBetween(from, to).catch(() => null);
      return {
        from: from.name,
        to: to.name,
        minutes: t?.minutes ?? null,
        via: t?.via ?? null,
        assumed: returnLocated && i === stops.length - 2,
      };
    }),
  );

  const transferMinutes = legs.reduce((sum, l) => sum + (l.minutes ?? 0), 0);
  const availableHours = c.days ? c.days * ACTIVE_HOURS_PER_DAY : null;
  const transferShare = availableHours ? transferMinutes / 60 / availableHours : null;
  const verdict: RoutePlan["verdict"] =
    transferShare === null
      ? "unknown"
      : transferShare >= OVERLOADED_SHARE
        ? "overloaded"
        : transferShare >= TIGHT_SHARE
          ? "tight"
          : "relaxed";

  return {
    stops: stops.map(({ name, lng, lat }) => ({ name, lng, lat })),
    legs,
    unresolved,
    transferMinutes,
    availableHours,
    transferShare,
    verdict,
  };
}
