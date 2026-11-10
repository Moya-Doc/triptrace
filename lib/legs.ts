import { drivingRoute, transitInCity, walkingRoute, type RoutePiece } from "./amap";
import type { GeoPoint, ItineraryItem, LegMode } from "./types";

// 同城两个地点之间怎么走：时间和距离都来自高德，选哪种方式由 TT 按规则决定（可核对、不用 LLM）：
// - 直线距离 1.2 公里以内：步行
// - 用户说了自驾 / 租车：自驾
// - 其他：公交地铁比打车最多慢 25 分钟就坐公交地铁，否则打车；超过 40 公里（比如去都江堰）直接打车
// 用户在地图上点连线改过的方式（chosenBy: user）以用户为准

export type LegOption = { mode: LegMode; minutes: number; distanceM: number | null; via: string | null };

const WALK_LIMIT_M = 1200;
const FAR_M = 40_000;

export function straightMeters(a: GeoPoint, b: GeoPoint) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

// 查一种方式的路线。结果连同（简化过的）路径一起缓存：选方式时查过的，地图上画路径时直接用，不再请求高德
type Routed = LegOption & { pieces: RoutePiece[] };
const cache = new Map<string, { at: number; value: Routed | null }>();
const CACHE_MS = 6 * 60 * 60 * 1000;

async function routed(a: GeoPoint, b: GeoPoint, mode: LegMode, city: string): Promise<Routed | null> {
  const key = `${mode}|${a.lng},${a.lat}|${b.lng},${b.lat}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value: Routed | null = null;
  try {
    if (mode === "walk") {
      const r = await walkingRoute(a, b);
      value = r && { mode, minutes: r.minutes, distanceM: r.distanceM, via: null, pieces: simplifyPieces(r.pieces) };
    } else if (mode === "transit") {
      const r = await transitInCity(a, b, city);
      value = r && {
        mode,
        minutes: r.minutes,
        distanceM: r.distanceM || null,
        via: r.lines.join(" → ") || "公交地铁",
        pieces: simplifyPieces(r.pieces),
      };
    } else {
      const r = await drivingRoute(a, b);
      // 打车比自驾多算 5 分钟等车
      value = r && {
        mode,
        minutes: r.minutes + (mode === "taxi" ? 5 : 0),
        distanceM: r.distanceM,
        via: null,
        pieces: simplifyPieces(r.pieces),
      };
    }
  } catch {
    return null;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function legOption(a: GeoPoint, b: GeoPoint, mode: LegMode, city: string): Promise<LegOption | null> {
  const r = await routed(a, b, mode, city);
  return r && { mode: r.mode, minutes: r.minutes, distanceM: r.distanceM, via: r.via };
}

// 单日详情的地图：某一段按它的交通方式走的真实路径
export async function legPieces(a: GeoPoint, b: GeoPoint, mode: LegMode, city: string): Promise<RoutePiece[] | null> {
  return (await routed(a, b, mode, city))?.pieces ?? null;
}

// 路径简化（道格拉斯-普克算法）：一段十几公里的路有上千个点，保留走向，去掉偏离不到约 15 米的点，
// 每段最多 120 个点，地图不卡，传输的数据也小
const TOLERANCE = 0.00015;

function simplifyPieces(pieces: RoutePiece[]): RoutePiece[] {
  return pieces.filter((p) => p.points.length > 1).map((p) => ({ ...p, points: capPoints(simplify(p.points, TOLERANCE), 120) }));
}

function simplify(points: [number, number][], tol: number): [number, number][] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let max = 0;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = distanceToSegment(points[k], points[i], points[j]);
      if (d > max) {
        max = d;
        at = k;
      }
    }
    if (max > tol && at > 0) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return points.filter((_, k) => keep[k]);
}

function capPoints(points: [number, number][], max: number) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, k) => points[Math.round(k * step)]);
}

function distanceToSegment(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// 三种方式都查一遍：给地图上"改交通方式"的面板用
export async function legOptions(a: GeoPoint, b: GeoPoint, city: string, transport: string | null) {
  const modes: LegMode[] = ["walk", "transit", selfDrive(transport) ? "drive" : "taxi"];
  const found = await Promise.all(modes.map((m) => legOption(a, b, m, city)));
  return found.filter((x): x is LegOption => x !== null);
}

function selfDrive(transport: string | null | undefined) {
  return Boolean(transport && /自驾|开车|租车/.test(transport));
}

// TT 按规则选交通方式，返回这一段的条目
export async function chooseLeg(input: {
  from: GeoPoint;
  to: GeoPoint;
  city: string;
  transport?: string | null;
  mode?: LegMode;
}): Promise<ItineraryItem> {
  const { from: a, to: b, city, transport, mode } = input;
  let pick: LegOption | null = null;
  if (mode) pick = await legOption(a, b, mode, city);
  else {
    const d = straightMeters(a, b);
    if (d <= WALK_LIMIT_M) pick = await legOption(a, b, "walk", city);
    else if (selfDrive(transport)) pick = await legOption(a, b, "drive", city);
    else if (d > FAR_M) pick = await legOption(a, b, "taxi", city);
    else {
      const [transit, taxi] = await Promise.all([legOption(a, b, "transit", city), legOption(a, b, "taxi", city)]);
      pick = transit && (!taxi || transit.minutes <= taxi.minutes + 25) ? transit : taxi;
    }
  }
  return {
    kind: "transit",
    title: `${a.name} → ${b.name}`,
    start: null,
    minutes: pick?.minutes ?? 0,
    via: pick ? pick.via : "高德没有查到路线",
    placeId: null,
    photo: null,
    verified: Boolean(pick),
    local: true,
    mode: pick?.mode ?? mode ?? "taxi",
    distanceM: pick?.distanceM ?? null,
    endpoints: { from: a, to: b },
    chosenBy: mode ? "user" : "tt",
  };
}
