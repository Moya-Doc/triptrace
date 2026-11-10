import { placeDetail } from "./amap";
import { parseHours } from "./hours";
import type { ItineraryItem } from "./types";

// 高德地点详情（照片、地址、电话、营业时间）的服务端缓存：一次请求约 1 秒，这些信息很少变，缓存 24 小时。
// 地点详情面板和开放时间核对共用
type Detail = NonNullable<Awaited<ReturnType<typeof placeDetail>>>;
const cache = new Map<string, { at: number; value: Promise<Detail | null> }>();
const CACHE_MS = 24 * 60 * 60 * 1000;

export function cachedPlaceDetail(id: string): Promise<Detail | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = placeDetail(id).catch(() => {
    cache.delete(id);
    return null;
  });
  cache.set(id, { at: Date.now(), value });
  return value;
}

// 给景点和用餐补上开放时间（只补还没有的、或者换了地点的），并行查询
export async function withHours(items: ItineraryItem[]): Promise<ItineraryItem[]> {
  return Promise.all(
    items.map(async (x) => {
      const id = x.kind === "place" ? x.placeId : x.kind === "free" ? x.venue?.placeId : null;
      if (!id || x.hours?.placeId === id) return x;
      const detail = await cachedPlaceDetail(id);
      if (!detail) return x;
      const parsed = parseHours(detail.openTime) ?? { text: "", ranges: null, closedDays: [], seasonal: false };
      return { ...x, hours: { ...parsed, placeId: id } };
    }),
  );
}
