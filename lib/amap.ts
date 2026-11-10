import { ConfigError } from "./llm";
import type { GeoPoint } from "./types";

// 高德 Web 服务 API 封装（只在服务端调用）。
// 所有坐标、距离、时间都从这里来，LLM 不参与。

const BASE = "https://restapi.amap.com";

// 个人开发者的并发额度很低，这里限制同时最多 3 个请求
const MAX_CONCURRENT = 3;
let active = 0;
const queue: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

export class AmapError extends Error {}

async function amapGet(path: string, params: Record<string, string>) {
  const key = process.env.AMAP_WEB_SERVICE_KEY;
  if (!key) throw new ConfigError("还没有配置高德 Web 服务 Key（AMAP_WEB_SERVICE_KEY）");

  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries({ ...params, key })) url.searchParams.set(k, v);

  for (let attempt = 0; ; attempt++) {
    let data;
    try {
      data = await withSlot(async () => {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
          console.error(`[amap] ${path} 返回 ${res.status}`);
          throw new AmapError("地图服务暂时不可用，请稍后重试");
        }
        return res.json();
      });
    } catch (e) {
      // 偶尔有一次请求卡住超时：重试一次，避免一个慢请求让整次生成失败
      if (e instanceof Error && e.name === "TimeoutError" && attempt < 1) continue;
      if (e instanceof AmapError) throw e;
      // 只记名字和说明，不记请求地址（里面有 Key）
      console.error(`[amap] ${path} 请求失败：${e instanceof Error ? e.name : String(e)}`);
      throw new AmapError(
        e instanceof Error && e.name === "TimeoutError" ? "地图服务响应太慢，请稍后重试" : "连不上地图服务，请检查网络后重试",
      );
    }
    if (data.status === "1") return data;
    // 超过每秒请求上限时，稍等再试，最多重试 2 次
    if (String(data.info).includes("CUQPS") && attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    console.error(`[amap] ${path} 接口错误：${data.info}（${data.infocode}）`);
    throw new AmapError("地图服务暂时不可用，请稍后重试");
  }
}

function parseLocation(loc: string): { lng: number; lat: number } {
  const [lng, lat] = loc.split(",").map(Number);
  return { lng, lat };
}

// 高德的地名服务只覆盖中国境内。查"悉尼"会匹配到江西一个叫"湖城国际"的小区，
// 查"东京"会匹配到广西的一个村子，所以必须检查匹配精度：只接受行政区级别的结果
const CITY_LEVELS = ["国家", "省", "市", "区县", "开发区", "乡镇"];

// 地名 → 坐标；不是中国境内的行政区时返回 null
export async function geocode(address: string): Promise<(GeoPoint & { city: string }) | null> {
  const data = await amapGet("/v3/geocode/geo", { address });
  const first = data.geocodes?.[0];
  if (!first?.location || !CITY_LEVELS.includes(first.level)) return null;
  const city = typeof first.city === "string" && first.city ? first.city : first.province;
  return { name: address, city, ...parseLocation(first.location) };
}

// 两个城市之间坐公共交通（含高铁）的门到门时间，取最快的方案
export async function transitBetween(
  from: GeoPoint & { city: string },
  to: GeoPoint & { city: string },
): Promise<{ minutes: number; via: string } | null> {
  const data = await amapGet("/v3/direction/transit/integrated", {
    origin: `${from.lng},${from.lat}`,
    destination: `${to.lng},${to.lat}`,
    city: from.city,
    cityd: to.city,
    strategy: "0",
  });
  type Segment = { railway?: { name?: string; trip?: string } };
  const transits: { duration: string; segments: Segment[] }[] = data.route?.transits ?? [];
  if (!transits.length) return null;
  const best = transits.reduce((a, b) => (Number(b.duration) < Number(a.duration) ? b : a));
  const trains = best.segments.map((s) => s.railway?.trip).filter(Boolean);
  return {
    minutes: Math.round(Number(best.duration) / 60),
    via: trains.length ? `火车 ${trains.join("、")}` : "公共交通",
  };
}

export type Poi = {
  id: string;
  name: string;
  type: string;
  district: string;
  address: string;
  lng: number;
  lat: number;
  photo: string | null;
  rating: number | null;
  distanceM: number | null;
};

type RawPoi = {
  id: string;
  name: string;
  type?: string;
  adname?: string;
  address?: string | unknown[];
  location?: string;
  photos?: { url?: string }[];
  biz_ext?: { rating?: string | unknown[] };
  distance?: string;
};

function toPoi(p: RawPoi): Poi | null {
  if (!p.location) return null;
  const rating = typeof p.biz_ext?.rating === "string" ? Number(p.biz_ext.rating) : NaN;
  // 高德的照片有两种来源：商家上传（store.is.autonavi.com，常是海报、菜单）
  // 和游客点评（aos-comment.amap.com，多是真实场景）。优先用游客拍的
  const urls = (p.photos ?? []).map((x) => x.url).filter((u): u is string => Boolean(u));
  const photo = (urls.find((u) => u.includes("aos-comment")) ?? urls[0])?.replace(/^http:\/\//, "https://") ?? null;
  return {
    id: p.id,
    name: p.name,
    type: p.type ?? "",
    district: p.adname ?? "",
    // 高德没有地址时会返回空数组
    address: typeof p.address === "string" ? p.address : "",
    ...parseLocation(p.location),
    photo,
    rating: Number.isFinite(rating) ? rating : null,
    distanceM: p.distance ? Number(p.distance) : null,
  };
}

// 在某个区县或城市里按关键字搜地点
export async function searchInCity(keywords: string[], city: string, limit = 15): Promise<Poi[]> {
  const data = await amapGet("/v3/place/text", {
    keywords: keywords.join("|"),
    city,
    citylimit: "true",
    offset: String(limit),
    page: "1",
    extensions: "all",
  });
  return ((data.pois ?? []) as RawPoi[]).map(toPoi).filter((p): p is Poi => p !== null);
}

// 搜某个坐标周边的地点，按距离从近到远
export async function searchAround(
  center: { lng: number; lat: number },
  keywords: string[],
  radiusM: number,
  // 高德的分类编码，例如 100000 是住宿服务
  types?: string,
  limit = 5,
): Promise<Poi[]> {
  const data = await amapGet("/v3/place/around", {
    location: `${center.lng},${center.lat}`,
    keywords: keywords.join("|"),
    radius: String(Math.min(radiusM, 50_000)),
    sortrule: "distance",
    offset: String(limit),
    ...(types ? { types } : {}),
  });
  return ((data.pois ?? []) as RawPoi[]).map(toPoi).filter((p): p is Poi => p !== null);
}

// 一次算出多个起点到同一个终点的驾车距离和时间（单次最多 100 个起点）
export async function drivingTo(
  origins: { lng: number; lat: number }[],
  dest: { lng: number; lat: number },
): Promise<({ distanceM: number; durationS: number } | null)[]> {
  const result: ({ distanceM: number; durationS: number } | null)[] = origins.map(() => null);
  for (let start = 0; start < origins.length; start += 100) {
    const batch = origins.slice(start, start + 100);
    const data = await amapGet("/v3/distance", {
      origins: batch.map((o) => `${o.lng},${o.lat}`).join("|"),
      destination: `${dest.lng},${dest.lat}`,
      type: "1",
    });
    for (const r of data.results ?? []) {
      const i = start + Number(r.origin_id) - 1;
      if (r.duration) result[i] = { distanceM: Number(r.distance), durationS: Number(r.duration) };
    }
  }
  return result;
}

// 同城路线：除了时间和距离，还带回真实路径（单日详情的地图上画出来）。
// 路径是一段段的：步行、驾车各一段；公交地铁按"步行到站 → 地铁 / 公交 → 换乘步行 → …"分段，每段有自己的坐标
export type RoutePiece = {
  kind: "walk" | "drive" | "subway" | "bus";
  name: string | null;
  points: [number, number][];
};

function parsePolyline(polyline: unknown): [number, number][] {
  if (typeof polyline !== "string" || !polyline) return [];
  return polyline.split(";").map((pair) => pair.split(",").map(Number) as [number, number]);
}

type RawStep = { polyline?: string };

function stepsToPoints(steps: RawStep[] | undefined) {
  return (steps ?? []).flatMap((st) => parsePolyline(st.polyline));
}

export async function walkingRoute(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
): Promise<{ distanceM: number; minutes: number; pieces: RoutePiece[] } | null> {
  const data = await amapGet("/v3/direction/walking", {
    origin: `${from.lng},${from.lat}`,
    destination: `${to.lng},${to.lat}`,
  });
  const path = data.route?.paths?.[0];
  if (!path) return null;
  return {
    distanceM: Number(path.distance),
    minutes: Math.max(1, Math.round(Number(path.duration) / 60)),
    pieces: [{ kind: "walk", name: null, points: stepsToPoints(path.steps) }],
  };
}

// 驾车路线（打车也用它）：比"距离测量"接口多了路径，时间也更贴近实际路况规划
export async function drivingRoute(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
): Promise<{ distanceM: number; minutes: number; pieces: RoutePiece[] } | null> {
  const data = await amapGet("/v3/direction/driving", {
    origin: `${from.lng},${from.lat}`,
    destination: `${to.lng},${to.lat}`,
    strategy: "0",
    extensions: "base",
  });
  const path = data.route?.paths?.[0];
  if (!path) return null;
  return {
    distanceM: Number(path.distance),
    minutes: Math.max(1, Math.round(Number(path.duration) / 60)),
    pieces: [{ kind: "drive", name: null, points: stepsToPoints(path.steps) }],
  };
}

// 同城公共交通（地铁、公交）：取高德排在第一的方案，记下乘坐的线路名和每一段的路径
export async function transitInCity(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
  city: string,
): Promise<{ distanceM: number; minutes: number; lines: string[]; pieces: RoutePiece[] } | null> {
  const data = await amapGet("/v3/direction/transit/integrated", {
    origin: `${from.lng},${from.lat}`,
    destination: `${to.lng},${to.lat}`,
    city,
    strategy: "0",
  });
  type Segment = {
    walking?: { steps?: RawStep[] } | unknown[];
    bus?: { buslines?: { name?: string; type?: string; polyline?: string }[] };
  };
  const best: { duration?: string; distance?: string; segments?: Segment[] } | undefined = data.route?.transits?.[0];
  if (!best?.duration) return null;
  const pieces: RoutePiece[] = [];
  const lines: string[] = [];
  for (const seg of best.segments ?? []) {
    // 没有步行段时高德返回空数组
    const walk = Array.isArray(seg.walking) ? [] : stepsToPoints(seg.walking?.steps);
    if (walk.length) pieces.push({ kind: "walk", name: null, points: walk });
    const line = seg.bus?.buslines?.[0];
    if (line?.polyline) {
      const name = line.name?.replace(/\(.*$/, "") ?? null;
      if (name) lines.push(name);
      pieces.push({
        kind: line.type?.includes("地铁") || name?.includes("地铁") ? "subway" : "bus",
        name,
        points: parsePolyline(line.polyline),
      });
    }
  }
  return {
    distanceM: Number(best.distance ?? 0),
    minutes: Math.round(Number(best.duration) / 60),
    lines,
    pieces,
  };
}

// 地点详情（单日详情里点开一个景点或餐厅）：多张照片、地址、电话、营业时间、评分
export async function placeDetail(id: string) {
  const data = await amapGet("/v3/place/detail", { id });
  type Raw = RawPoi & {
    tel?: string | unknown[];
    biz_ext?: { rating?: string | unknown[]; open_time?: string | unknown[]; star?: string | unknown[]; lowest_price?: string | unknown[] };
  };
  const raw = (data.pois ?? [])[0] as Raw | undefined;
  if (!raw) return null;
  const base = toPoi(raw);
  if (!base) return null;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  const num = (v: unknown) => (typeof v === "string" && v && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    ...base,
    photos: (raw.photos ?? [])
      .map((x) => x.url?.replace(/^http:\/\//, "https://"))
      .filter((u): u is string => Boolean(u))
      .slice(0, 6),
    tel: text(raw.tel),
    openTime: text(raw.biz_ext?.open_time),
    hotel: base.type.includes("住宿服务") ? await hotelInfo(id, base.type, num(raw.biz_ext?.star), num(raw.biz_ext?.lowest_price)) : null,
  };
}

// 酒店的补充信息。高德 v3 的 star（星级）只有少数酒店有，lowest_price（最低房价）实测都是空的；
// v5 的 business 里有档次（keytag，例如"豪华型""舒适型""五星级酒店"）和别名（alias，有的带英文名）。
// 没有的就留空，界面上不显示，不编
async function hotelInfo(id: string, type: string, star: number | null, lowestPrice: number | null) {
  let grade: string | null = null;
  let nameEn: string | null = null;
  try {
    const v5 = await amapGet("/v5/place/detail", { id, show_fields: "business" });
    const business = v5.pois?.[0]?.business ?? {};
    grade = typeof business.keytag === "string" && business.keytag ? business.keytag : null;
    const alias = typeof business.alias === "string" ? business.alias.split("|") : [];
    nameEn = alias.find((a: string) => /^[A-Za-z][A-Za-z0-9 .,'&()-]+$/.test(a.trim()))?.trim() ?? null;
  } catch {
    // v5 查不到不影响其他信息
  }
  // 星级：优先用 star，其次从分类里认（"五星级宾馆"）
  const fromType = type.match(/([一二三四五])星级/)?.[1];
  const stars = star ?? (fromType ? "一二三四五".indexOf(fromType) + 1 : null);
  return { stars, grade, nameEn, lowestPrice };
}

// 浏览器定位给的是国际通用的 WGS-84 坐标，国内地图用的是加密偏移后的 GCJ-02 坐标（俗称"火星坐标"），
// 直接用会偏几百米，所以先转换，再查这个坐标在哪个城市。境外坐标查不到城市，返回 null
export async function cityAt(lng: number, lat: number): Promise<string | null> {
  const converted = await amapGet("/v3/assistant/coordinate/convert", {
    locations: `${lng},${lat}`,
    coordsys: "gps",
  });
  const location = typeof converted.locations === "string" ? converted.locations.split(";")[0] : null;
  if (!location) return null;
  const data = await amapGet("/v3/geocode/regeo", { location });
  const comp = data.regeocode?.addressComponent;
  const city = typeof comp?.city === "string" && comp.city ? comp.city : comp?.province;
  return typeof city === "string" && city ? city : null;
}
