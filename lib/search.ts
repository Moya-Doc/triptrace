import { drivingTo, searchAround, searchInCity, type Poi } from "./amap";
import type { Candidate, Check, Constraints, GeoPoint } from "./types";

// ② 检索与计算：全部由代码 + 高德 API 完成，不经过 LLM。
// 1. 按硬约束在各个区县里搜候选地点
// 2. 一次请求算出所有候选地点到参照城市的车程
// 3. 对排在前面的候选地点，逐个查周边有没有软约束要求的地点
// 4. 用规则打分排序：每满足一个软约束加 1 分

const NEARBY_CHECK_LIMIT = 12;
const RESULT_LIMIT = 8;
const CACHE_TTL_MS = 10 * 60 * 1000;

// 同样的条件 10 分钟内不重复调用高德（例如用户只是说了句"没问题"）
const cache = new Map<string, { at: number; value: Candidate[] }>();

// 搜"露营地"时，高德也会返回卖装备的店、停车场等，按类型排除
const EXCLUDED_TYPES = ["购物服务", "汽车服务", "汽车销售", "汽车维修", "公司企业", "交通设施服务"];
// 高德会在店名里标注"暂停营业"等状态，这类地点不能算满足条件
const CLOSED_MARKERS = ["暂停营业", "停业", "已关闭", "已关停"];

function isOpen(p: Poi) {
  return !CLOSED_MARKERS.some((m) => p.name.includes(m));
}

export async function findCandidates(c: Constraints, center: GeoPoint): Promise<Candidate[]> {
  const keywords = [...new Set(c.hard.flatMap((h) => h.keywords))];
  if (!keywords.length) return [];
  const regions = (c.search_regions.length ? c.search_regions : [center.name]).slice(0, 5);
  const maxDrive = c.soft.find((s) => s.type === "max_drive_time");
  const nearbyRules = c.soft.filter((s) => s.type === "nearby_poi");

  const cacheKey = JSON.stringify({ keywords, regions, maxDrive, nearbyRules, center });
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  // 1. 搜候选地点，按 id 去重
  const perRegion = await Promise.all(regions.map((r) => searchInCity(keywords, r)));
  const seen = new Set<string>();
  const pois = perRegion
    .flat()
    .filter((p) => isOpen(p) && !EXCLUDED_TYPES.some((t) => p.type.includes(t)))
    .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  if (!pois.length) return [];

  // 2. 车程
  const drives = await drivingTo(pois, center);
  const limitMin = maxDrive ? maxDrive.hours * 60 : null;
  let pool = pois.map((p, i) => ({
    poi: p,
    driveMinutes: drives[i] ? Math.round(drives[i]!.durationS / 60) : null,
    distanceKm: drives[i] ? Math.round(drives[i]!.distanceM / 100) / 10 : null,
  }));
  // 车程超过上限 1.5 倍的直接去掉；略超上限的保留，用来讲取舍
  if (limitMin) pool = pool.filter((x) => x.driveMinutes === null || x.driveMinutes <= limitMin * 1.5);

  // 先按"车程达标 → 评分高"粗排，只对前面的候选地点查周边，节省请求次数
  pool.sort(
    (a, b) =>
      Number(withinLimit(b.driveMinutes, limitMin)) - Number(withinLimit(a.driveMinutes, limitMin)) ||
      (b.poi.rating ?? 0) - (a.poi.rating ?? 0),
  );
  pool = pool.slice(0, NEARBY_CHECK_LIMIT);

  // 3. 周边检查
  const nearbyResults = await Promise.all(
    pool.map((x) =>
      Promise.all(
        nearbyRules.map(async (rule) => {
          const found = await searchAround(x.poi, rule.keywords, rule.radius_km * 1000);
          // 周边搜索是模糊匹配，会混进不相关的店，必须名称里真的含有关键词
          return found.find((p) => isOpen(p) && rule.keywords.some((k) => p.name.includes(k))) ?? null;
        }),
      ),
    ),
  );

  // 4. 打分排序
  const scored = pool.map((x, i) => {
    const checks: Check[] = [];
    if (maxDrive && limitMin) {
      checks.push({
        label: maxDrive.label,
        ok: withinLimit(x.driveMinutes, limitMin),
        detail: x.driveMinutes === null ? "车程未知" : `从${maxDrive.from}自驾约 ${formatMinutes(x.driveMinutes)}`,
      });
    }
    nearbyRules.forEach((rule, j) => {
      const p: Poi | null = nearbyResults[i][j];
      checks.push({
        label: rule.label,
        ok: Boolean(p),
        detail: p
          ? `${p.name}，相距 ${formatDistance(p.distanceM)}`
          : `${rule.radius_km} 公里内没有找到`,
      });
    });
    return {
      ...x,
      checks,
      score: checks.filter((ch) => ch.ok).length,
      maxScore: checks.length,
    };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.poi.rating ?? 0) - (a.poi.rating ?? 0) ||
      (a.driveMinutes ?? Infinity) - (b.driveMinutes ?? Infinity),
  );

  const result: Candidate[] = scored.slice(0, RESULT_LIMIT).map((x, i) => ({
    rank: i + 1,
    id: x.poi.id,
    name: x.poi.name,
    district: x.poi.district,
    address: x.poi.address,
    lng: x.poi.lng,
    lat: x.poi.lat,
    photo: x.poi.photo,
    rating: x.poi.rating,
    driveMinutes: x.driveMinutes,
    distanceKm: x.distanceKm,
    checks: x.checks,
    score: x.score,
    maxScore: x.maxScore,
  }));
  cache.set(cacheKey, { at: Date.now(), value: result });
  return result;
}

function withinLimit(minutes: number | null, limit: number | null) {
  return limit === null || (minutes !== null && minutes <= limit);
}

export function formatMinutes(m: number) {
  const h = Math.floor(m / 60);
  return h ? `${h} 小时${m % 60 ? ` ${m % 60} 分钟` : ""}` : `${m} 分钟`;
}

function formatDistance(m: number | null) {
  if (m === null) return "距离未知";
  return m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${m} 米`;
}
