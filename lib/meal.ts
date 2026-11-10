import { toMinutes } from "./load";
import type { ItineraryItem } from "./types";

// 加进来的地点如果是餐厅（高德分类属于"餐饮服务"），就作为一顿饭，而不是景点：
// 标"餐厅"、默认 1 小时、受饭点约束（午餐最早 11:30、晚餐最早 17:30）。
// 是午餐还是晚餐，看它前一项几点结束：15:00 之前算午餐，之后算晚餐。
// 这一天已经有这顿饭时，要问用户：替换原来的，还是额外加一站（"加餐"，不受饭点约束）

export type MealSlot = "午餐" | "晚餐";

export function isRestaurant(type: string | null | undefined) {
  return Boolean(type && type.includes("餐饮"));
}

export function mealSlot(order: ItineraryItem[], at: number): MealSlot {
  const prev = [...order.slice(0, at)].reverse().find((x) => x.start);
  const end = prev?.start ? toMinutes(prev.start) + prev.minutes : 9 * 60;
  return end < 15 * 60 ? "午餐" : "晚餐";
}

type Spot = { id: string; name: string; photo: string | null; lng: number; lat: number; distanceM?: number | null };

export function venueOf(p: Spot) {
  return { name: p.name, placeId: p.id, photo: p.photo, lng: p.lng, lat: p.lat, distanceM: p.distanceM ?? null, near: null, why: null };
}

export function mealItem(title: MealSlot | "加餐", p: Spot): ItineraryItem {
  return {
    kind: "free",
    title,
    start: null,
    minutes: title === "加餐" ? 45 : 60,
    via: null,
    placeId: null,
    photo: null,
    verified: false,
    venue: venueOf(p),
  };
}
