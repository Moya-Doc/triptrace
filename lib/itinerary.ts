import { geocode, searchAround, searchInCity, transitBetween, type Poi } from "./amap";
import { chatJson } from "./llm";
import { dayLoad, dayWindow, toClock, toMinutes } from "./load";
import type {
  Candidate,
  Constraints,
  GeoPoint,
  Itinerary,
  ItineraryDay,
  ItineraryItem,
  LegMode,
  RoutePlan,
  Venue,
} from "./types";
import { chooseLeg } from "./legs";
import { checkVisit, earliestOpenStart } from "./hours";
import { withHours } from "./places";

// "生成规划"：产出逐日行程。和其他模块一样分工——
// 1. 代码搭骨架：按日期分天、把城市分配到每一天、把城市间的交通放到换城的那天（时间来自高德）
// 2. LLM 只做"挑选和排序"：从高德查到的地点池里，给每天挑几个地点、排好时间、估计停留多久
// 3. 代码再核对和计算：地点必须来自地点池；相邻两个地点之间的车程由高德计算；每天的负荷由规则判断
// 负荷条是创新点 I2：用真实交通时间算出"路上 / 游玩"，路上太久的那天标红（Layla 做不到这一点）


export type PoolItem = {
  id: string;
  name: string;
  district: string;
  rating: number | null;
  photo: string | null;
  lng: number;
  lat: number;
  // 高德的分类，例如"餐饮服务;中餐厅;火锅店"：用来判断加进来的是景点还是餐厅
  type?: string;
};

type Skeleton = {
  index: number;
  date: string;
  city: string;
  before: ItineraryItem[];
  after: ItineraryItem[];
};

export async function generateItinerary(input: {
  constraints: Constraints;
  candidates: Candidate[];
  shortlist: Candidate[];
  route: RoutePlan | null;
}): Promise<Itinerary> {
  const { constraints: c, candidates, shortlist, route } = input;
  const start = c.start_date ?? new Date().toISOString().slice(0, 10);
  if (!c.end_date) throw new Error("还没有结束日期");
  const dayCount =
    Math.round((Date.parse(c.end_date) - Date.parse(start)) / 86_400_000) + 1;
  if (dayCount < 1) throw new Error("结束日期早于开始日期");
  const dates = Array.from({ length: dayCount }, (_, i) =>
    new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10),
  );

  // 1. 骨架：要去的城市（多城路线），或者一个区域（选目的地）
  const isRoute = c.intent === "feasibility_check" && c.cities.length > 0;
  const places = isRoute
    ? c.cities
    : ([c.anchor ?? c.cities[0]].filter(Boolean) as string[]);
  if (!places.length) throw new Error("还没有目的地");
  const perCity = allocateDays(dayCount, places.length);
  const skeleton: Skeleton[] = [];
  places.forEach((city, ci) => {
    for (let k = 0; k < perCity[ci]; k++) {
      skeleton.push({
        index: skeleton.length,
        date: dates[skeleton.length],
        city,
        before: [],
        after: [],
      });
    }
  });

  // 城市间的交通：出发地 → 第一座城市放在第 1 天开头；换城放在新城市第一天的开头；返程放在最后一天结尾
  const legsWanted: {
    from: string;
    to: string;
    day: number;
    at: "before" | "after";
  }[] = [];
  if (c.origin && c.origin !== places[0])
    legsWanted.push({ from: c.origin, to: places[0], day: 0, at: "before" });
  places.forEach((city, ci) => {
    if (ci === 0) return;
    const firstDay = skeleton.find((d) => d.city === city)!.index;
    legsWanted.push({
      from: places[ci - 1],
      to: city,
      day: firstDay,
      at: "before",
    });
  });
  const lastCity = places[places.length - 1];
  if (c.origin && c.origin !== lastCity) {
    legsWanted.push({
      from: lastCity,
      to: c.origin,
      day: skeleton.length - 1,
      at: "after",
    });
  }
  const legs = await Promise.all(
    legsWanted.map((l) => interCity(l.from, l.to, route)),
  );
  legsWanted.forEach((l, i) => {
    const leg = legs[i];
    skeleton[l.day][l.at].push({
      kind: "transit",
      title: `${l.from} → ${l.to}`,
      start: null,
      minutes: leg?.minutes ?? 0,
      via: leg ? leg.via : "高德没有查到这段交通",
      placeId: null,
      photo: null,
      verified: Boolean(leg),
    });
  });

  // 2. 地点池：选目的地时用候选栏和推荐结果；多城路线时在每座城市里查评分高的地点
  const pools = new Map<string, PoolItem[]>();
  if (isRoute) {
    // 高德的关键字和类别搜索都排不出热门景点（成都会搜出一堆小公园和小寺庙），
    // 所以让 LLM 根据偏好提名，再逐个到高德核实：查得到、名字对得上的才用，坐标和照片都来自高德
    await Promise.all(
      places.map(async (city) =>
        pools.set(city, await verifiedAttractions(city, c)),
      ),
    );
  } else {
    const seen = new Set<string>();
    pools.set(
      places[0],
      [...shortlist, ...candidates]
        .filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)))
        .slice(0, 8)
        .map((x) => ({
          id: x.id,
          name: x.name,
          district: x.district,
          rating: x.rating,
          photo: x.photo,
          lng: x.lng,
          lat: x.lat,
        })),
    );
  }
  if (![...pools.values()].some((p) => p.length))
    throw new Error("没有找到可以安排进行程的地点");

  // 3. LLM 挑选和排序
  const arranged = await arrange(
    c,
    skeleton,
    pools,
    shortlist,
    isRoute ? "attractions" : "destinations",
  );

  // 4. 组装：核对地点、插入相邻地点之间的车程、计算每天的负荷
  const anchorPoint =
    !isRoute && c.anchor ? await geocode(c.anchor).catch(() => null) : null;
  // 按天顺序处理：前一天最后待的地方（比如住的营地），就是第二天的起点
  const days: ItineraryDay[] = [];
  let carry: { city: string; point: GeoPoint } | null = null;
  for (const d of skeleton) {
    {
      const pool = pools.get(d.city) ?? [];
      const picked = (arranged.get(d.index)?.items ?? [])
        .filter((it) => it.place_id || !/入住|休息/.test(it.title ?? ""))
        .flatMap(
        (it): (ItineraryItem & { point?: GeoPoint })[] => {
          if (it.place_id) {
            const p = pool.find((x) => x.id === it.place_id);
            if (!p) return []; // 不在地点池里的地点一律丢掉，不让模型编地点
            return [
              {
                kind: "place",
                title: p.name,
                start: it.start,
                minutes: clamp(it.stay_minutes, 30, 8 * 60),
                via: null,
                placeId: p.id,
                photo: p.photo,
                verified: false,
                point: { name: p.name, lng: p.lng, lat: p.lat },
              },
            ];
          }
          return [
            {
              kind: "free",
              title: it.title,
              start: it.start,
              minutes: clamp(it.stay_minutes, 15, 4 * 60),
              via: null,
              placeId: null,
              photo: null,
              verified: false,
            },
          ];
        },
      );

      // 选目的地的行程：第一天从参照城市出发，最后一天回到参照城市，车程由高德计算
      const middle: ItineraryItem[] = [];
      let prev: GeoPoint | null =
        d.index === 0
          ? anchorPoint
          : // 只有选目的地的行程（比如露营）才会住在地点本身；城市游晚上回酒店，第二天不从景点出发
            !isRoute && carry && carry.city === d.city
            ? carry.point
            : null;
      // 这里只放"从城市出发"的第一段；景点之间、餐厅、住宿的交通段在最后统一由 relayoutDay 按规则计算
      const transport = c.slots.transport.value;
      let first = true;
      for (const it of picked) {
        if (it.point && prev && first && !samePlace(prev, it.point))
          middle.push(await chooseLeg({ from: prev, to: it.point, city: d.city, transport }));
        const { point, ...item } = it;
        middle.push(point ? { ...item, lng: point.lng, lat: point.lat } : item);
        if (point) {
          prev = point;
          first = false;
        }
      }
      if (
        d.index === skeleton.length - 1 &&
        anchorPoint &&
        prev &&
        !samePlace(prev, anchorPoint)
      ) {
        middle.push(await chooseLeg({ from: prev, to: anchorPoint, city: d.city, transport }));
      }
      if (prev) carry = { city: d.city, point: prev };

      // 住宿：最后一天不住；选目的地的行程（比如露营）就住在当天待的地点；城市游查当天最后一个地点附近的住宿
      const lastDay = d.index === skeleton.length - 1;
      const stay = lastDay
        ? []
        : [await stayItem(c, d.city, prev, !isRoute && prev ? pool.find((p) => p.name === prev!.name) : undefined)];
      const items = [...d.before, ...middle, ...stay, ...d.after];
      const transitMinutes = items
        .filter((x) => x.kind === "transit")
        .reduce((s, x) => s + x.minutes, 0);
      const playMinutes = items
        .filter((x) => x.kind !== "transit")
        .reduce((s, x) => s + x.minutes, 0);
      days.push({
        intro: arranged.get(d.index)?.intro ?? null,
        index: d.index,
        date: d.date,
        city: d.city,
        items,
        transitMinutes,
        playMinutes,
        load: dayLoad(transitMinutes, playMinutes),
        done: false,
      });
    }
  }

  // 餐厅由 TT 从每顿饭附近的候选里挑；然后每天统一排交通段和时间
  await assignRestaurants(days, c);
  const laidOut = await Promise.all(
    days.map((d) =>
      relayoutDay(
        d,
        d.items.filter((x) => x.kind === "place" || x.kind === "free"),
        { transport: c.slots.transport.value },
      ),
    ),
  );
  days.splice(0, days.length, ...laidOut);

  const banner = [...pools.values()].flat().find((p) => p.photo)?.photo ?? null;
  return {
    title: isRoute ? places.join(" → ") : `${places[0]}周边`,
    banner,
    days,
    generatedAt: new Date().toISOString(),
  };
}

// 天数平均分给每座城市，多出来的天给排在前面的城市
function allocateDays(days: number, cities: number) {
  const base = Math.max(1, Math.floor(days / cities));
  const extra = Math.max(0, days - base * cities);
  return Array.from({ length: cities }, (_, i) => base + (i < extra ? 1 : 0));
}


// 城市间交通：优先用可行性检查已经算好的结果，没有再查高德
async function interCity(from: string, to: string, route: RoutePlan | null) {
  const known = route?.legs.find(
    (l) => l.from === from && l.to === to && l.minutes !== null,
  );
  if (known) return { minutes: known.minutes!, via: known.via ?? "公共交通" };
  const [a, b] = await Promise.all([geocode(from), geocode(to)]);
  if (!a || !b) return null;
  return transitBetween(a, b).catch(() => null);
}

// 住宿栏位。住在选定的地点本身（露营），或者在高德里找离当天最后一个地点最近的住宿（按住宿偏好筛选）
async function stayItem(
  c: Constraints,
  city: string,
  near: GeoPoint | null,
  stayAt: PoolItem | undefined,
): Promise<ItineraryItem> {
  if (stayAt) {
    return {
      kind: "stay",
      title: stayAt.name,
      start: null,
      minutes: 0,
      via: "住在这里",
      placeId: stayAt.id,
      photo: stayAt.photo,
      verified: true,
      lng: stayAt.lng,
      lat: stayAt.lat,
    };
  }
  const center = near ?? (await geocode(city).catch(() => null));
  const lodging = c.slots.lodging.value;
  // 高德自己会把一些店归错类：比如一家香水店被标成了"住宿服务相关"。
  // 所以默认只要"宾馆酒店"和"旅馆招待所"两个子类；用户指定了民宿、客栈这类偏好时，才放宽到整个住宿大类
  const specific = Boolean(lodging && /民宿|客栈|青旅|公寓/.test(lodging));
  const found = center
    ? await searchAround(center, lodging ? [lodging] : ["酒店"], 3000, specific ? "100000" : "100100|100200").catch(
        () => [],
      )
    : [];
  const typeOk = (t: string) => (specific ? t.includes("住宿服务") : /宾馆酒店|旅馆招待所/.test(t));
  const hotel = found.find((p) => typeOk(p.type) && !/暂停营业|暂停开放|停业|已关闭/.test(p.name));
  if (!hotel) {
    return {
      kind: "stay",
      title: "住宿待定",
      start: null,
      minutes: 0,
      via: "附近没有查到合适的住宿，可以在对话里让 TT 帮你找",
      placeId: null,
      photo: null,
      verified: false,
    };
  }
  return {
    kind: "stay",
    title: hotel.name,
    start: null,
    minutes: 0,
    via: near && hotel.distanceM !== null ? `离${near.name}约 ${hotel.distanceM} 米` : hotel.district,
    placeId: hotel.id,
    photo: hotel.photo,
    verified: true,
    lng: hotel.lng,
    lat: hotel.lat,
  };
}

// 换一家住宿：用户指定了名字就在城市里搜，否则在原来住处（或当天最后一个地点）附近找另一家
export async function findHotel(input: {
  city: string;
  near: GeoPoint | null;
  query?: string;
  exclude?: string | null;
}): Promise<ItineraryItem | null> {
  const { city, near, query, exclude } = input;
  const found = query
    ? await searchInCity([query], city, 10).catch(() => [])
    : near
      ? await searchAround(near, ["酒店"], 3000, "100100|100200").catch(() => [])
      : [];
  const hotel = found.find(
    (p) => p.type.includes("住宿服务") && p.id !== exclude && !/暂停营业|暂停开放|停业|已关闭/.test(p.name),
  );
  if (!hotel) return null;
  return {
    kind: "stay",
    title: hotel.name,
    start: null,
    minutes: 0,
    via: near && hotel.distanceM !== null && !query ? `离${near.name}约 ${hotel.distanceM} 米` : hotel.district,
    placeId: hotel.id,
    photo: hotel.photo,
    verified: true,
    lng: hotel.lng,
    lat: hotel.lat,
  };
}

// 生成行程时挑餐厅：和景点一样"LLM 提名、高德核实"——
// 代码先在每顿饭前后的地点附近（到达日在住处附近）从高德查 10 家候选，LLM 结合用户的偏好从候选里挑，
// 挑出来的必须在候选里；LLM 出错时退回到最近的一家
const RESTAURANT_PROMPT = `你是旅行顾问，给行程里的每一顿饭从候选餐厅里挑一家。输出 JSON：{"choices":[{"slot":"槽位编号","id":"候选的 id","why":"一句理由，不超过 14 个字"}]}

- 只能从这一顿的候选里挑，id 照抄
- 用户的偏好优先（例如想吃火锅、不吃辣、素食）；没有偏好时，优先当地特色和评分高的店，少选全国连锁快餐
- 同一趟行程不要重复同一家，菜系尽量错开
- why 写这家的特点，例如"本地老字号川菜""评分 4.7 的火锅"，不要编造候选里没有的信息`;

async function assignRestaurants(days: ItineraryDay[], c: Constraints) {
  type Slot = { key: string; item: ItineraryItem; near: GeoPoint; candidates: Poi[] };
  const slots: Slot[] = [];
  for (const d of days) {
    const items = d.items;
    for (let i = 0; i < items.length; i++) {
      const x = items[i];
      if (x.kind !== "free" || !/餐/.test(x.title) || x.venue) continue;
      const ref = mealReference(items, i);
      if (ref) slots.push({ key: `d${d.index + 1}-${x.title}`, item: x, near: ref, candidates: [] });
    }
  }
  await Promise.all(
    slots.map(async (s) => {
      const found = await searchAround(s.near, ["餐厅"], 1500, "050000", 10).catch(() => []);
      s.candidates = found.filter((p) => p.type.includes("餐饮") && !/暂停营业|暂停开放|停业|已关闭/.test(p.name));
    }),
  );
  const usable = slots.filter((s) => s.candidates.length);
  if (!usable.length) return;

  let choices: { slot?: string; id?: string; why?: string }[] = [];
  try {
    const raw = (await chatJson([
      { role: "system", content: RESTAURANT_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          偏好: [...c.hard, ...c.soft].map((x) => x.label),
          补充: c.extra,
          槽位: usable.map((s) => ({
            slot: s.key,
            附近: s.near.name,
            候选: s.candidates.map((p) => ({
              id: p.id,
              name: p.name,
              菜系: p.type.split(";").slice(1).join(" / "),
              rating: p.rating,
              distanceM: p.distanceM,
            })),
          })),
        }),
      },
    ])) as { choices?: unknown };
    if (Array.isArray(raw.choices)) choices = raw.choices as typeof choices;
  } catch {
    // LLM 出错就用最近的一家
  }
  for (const s of usable) {
    const pickChoice = choices.find((ch) => ch.slot === s.key);
    const p = s.candidates.find((x) => x.id === pickChoice?.id) ?? s.candidates.slice(0, 3).find((x) => x.photo) ?? s.candidates[0];
    s.item.venue = {
      name: p.name,
      placeId: p.id,
      photo: p.photo,
      lng: p.lng,
      lat: p.lat,
      distanceM: p.distanceM,
      near: s.near.name,
      why: p.id === pickChoice?.id && typeof pickChoice.why === "string" ? pickChoice.why.slice(0, 20) : null,
    };
  }
}

// 一顿饭在哪附近吃：前一个景点，没有就后一个景点，再没有就住处
function mealReference(items: ItineraryItem[], i: number): GeoPoint | null {
  const isPoint = (kind: ItineraryItem["kind"]) => (y: ItineraryItem) =>
    y.kind === kind && y.lng !== undefined && y.lat !== undefined;
  const ref =
    [...items.slice(0, i)].reverse().find(isPoint("place")) ??
    items.slice(i + 1).find(isPoint("place")) ??
    items.find(isPoint("stay"));
  return ref ? { name: ref.title, lng: ref.lng!, lat: ref.lat! } : null;
}

// 用餐的餐厅：在前一个地点附近找（一天的第一顿饭就找后一个地点附近；都没有就找住处附近），只补还没有餐厅的那几顿。
// 已经选好的餐厅保持不变，所以拖动、改时间时不会反复查询
export async function withVenues(items: ItineraryItem[]): Promise<ItineraryItem[]> {
  const out: ItineraryItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const x = items[i];
    if (x.kind !== "free" || !/餐/.test(x.title) || x.venue) {
      out.push(x);
      continue;
    }
    const ref = mealReference(items, i);
    const venue = ref ? await findRestaurant({ near: ref }) : null;
    out.push(venue ? { ...x, venue } : x);
  }
  return out;
}

// 找一家餐厅：指定了名字就在城市里搜，否则在某个地点附近按距离找，优先有照片的
export async function findRestaurant(input: {
  near: GeoPoint | null;
  city?: string;
  query?: string;
  exclude?: string | null;
}): Promise<Venue | null> {
  const { near, city, query, exclude } = input;
  let found: Poi[] = [];
  try {
    if (query && city) found = await searchInCity([query], city, 10);
    else if (near) found = await searchAround(near, query ? [query] : ["餐厅"], 1500, "050000");
  } catch {
    return null;
  }
  const ok = found.filter(
    (p) => p.type.includes("餐饮") && p.id !== exclude && !/暂停营业|暂停开放|停业|已关闭/.test(p.name),
  );
  const p = ok.slice(0, 3).find((x) => x.photo) ?? ok[0];
  if (!p) return null;
  return {
    name: p.name,
    placeId: p.id,
    photo: p.photo,
    lng: p.lng,
    lat: p.lat,
    distanceM: p.distanceM,
    near: near && !query ? near.name : null,
  };
}

function samePlace(a: GeoPoint, b: GeoPoint) {
  return Math.abs(a.lng - b.lng) < 1e-5 && Math.abs(a.lat - b.lat) < 1e-5;
}

function clamp(n: unknown, min: number, max: number) {
  const v = typeof n === "number" && Number.isFinite(n) ? n : min;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export async function verifiedAttractions(
  city: string,
  c: Constraints,
): Promise<PoolItem[]> {
  const raw = (await chatJson([
    {
      role: "system",
      content:
        '你是旅行顾问。列出某座城市最值得去的 8 个地点的标准名称（地图上能搜到的正式名称），结合用户偏好。输出 JSON：{"names":[...]}，只输出 JSON。',
    },
    {
      role: "user",
      content: JSON.stringify({
        city,
        preferences: [...c.hard, ...c.soft].map((x) => x.label),
        extra: c.extra,
      }),
    },
  ]).catch(() => ({}))) as { names?: unknown };
  const names = Array.isArray(raw.names)
    ? raw.names.filter((n): n is string => typeof n === "string").slice(0, 8)
    : [];
  const norm = (t: string) => t.replace(/[\s·（）()]/g, "");
  const found = await Promise.all(
    names.map(async (name) => {
      const [p] = await searchInCity([name], city, 1).catch(() => []);
      // 名字要对得上：高德返回的名字包含提名，或者提名包含高德的名字，防止搜到不相干的地方
      if (
        !p ||
        !(
          norm(p.name).includes(norm(name)) || norm(name).includes(norm(p.name))
        )
      )
        return null;
      if (/暂停营业|暂停开放|停业|已关闭/.test(p.name)) return null;
      const item: PoolItem = {
        id: p.id,
        name: p.name,
        district: p.district,
        rating: p.rating,
        photo: p.photo,
        lng: p.lng,
        lat: p.lat,
        type: p.type,
      };
      return item;
    }),
  );
  const seen = new Set<string>();
  return found.filter(
    (p): p is PoolItem =>
      p !== null && (seen.has(p.id) ? false : (seen.add(p.id), true)),
  );
}

type Arranged = {
  place_id: string | null;
  title: string;
  start: string | null;
  stay_minutes: number;
};

const ARRANGE_PROMPT = `你是 TripTrace 的行程编排模块。根据骨架和地点池，为每一天挑选地点并排好时间。输出 JSON：
{"days":[{"index":天的序号,"intro":这一天的介绍,"items":[{"place_id":地点池里的 id 或 null,"title":名称,"start":"HH:MM","stay_minutes":数字}]}]}

规则：
1. 具体地点只能从这一天所在城市的地点池里选，place_id 必须原样照抄；每个地点整个行程只出现一次
2. place_id 为 null 的只能是通用安排，title 只能写"早餐""午餐""晚餐""自由活动""登山徒步""营地活动""周边散步"这类词，不能写任何店名或地名。不要安排"入住休息"，住宿由系统单独查询
3. 有城市间交通的那天，交通会占掉对应的时间（before 在当天开头，after 在当天结尾），这一天少排地点
4. 节奏轻松：每天最多 2 个地点；适中：最多 3 个；不知道节奏按轻松算
5. 用户放进候选栏的地点（shortlisted 为 true）优先安排
6. pool_kind 为 "destinations" 时，地点池是同一类候选目的地（比如几个营地），用户只会去其中一个：
   整个行程只选 1 个（5 天以上最多 2 个），作为住宿和主要活动地点；其余时间用通用安排，例如"登山徒步""营地活动""周边散步"
7. 每天从 09:00 左右开始，22:00 前结束；stay_minutes 是建议停留的分钟数
8. intro：一两句话介绍这一天，说清在哪、主要做什么，语气像朋友。只写常识性的介绍，不要写价格、开放时间、距离等具体数字
9. 只输出 JSON`;

async function arrange(
  c: Constraints,
  skeleton: Skeleton[],
  pools: Map<string, PoolItem[]>,
  shortlist: Candidate[],
  poolKind: "attractions" | "destinations",
): Promise<Map<number, { intro: string | null; items: Arranged[] }>> {
  const shortIds = new Set(shortlist.map((x) => x.id));
  const content = JSON.stringify({
    pool_kind: poolKind,
    pace: c.slots.pace.value,
    companions: c.slots.companions.value,
    lodging: c.slots.lodging.value,
    preferences: [...c.hard, ...c.soft].map((x) => x.label),
    extra: c.extra,
    days: skeleton.map((d) => ({
      index: d.index,
      date: d.date,
      city: d.city,
      before: d.before.map((x) => `${x.title}，约 ${x.minutes} 分钟`),
      after: d.after.map((x) => `${x.title}，约 ${x.minutes} 分钟`),
    })),
    pools: Object.fromEntries(
      [...pools].map(([city, list]) => [
        city,
        list.map((p) => ({
          id: p.id,
          name: p.name,
          district: p.district,
          rating: p.rating,
          shortlisted: shortIds.has(p.id),
        })),
      ]),
    ),
  });
  const raw = (await chatJson([
    { role: "system", content: ARRANGE_PROMPT },
    { role: "user", content },
  ])) as { days?: { index?: number; intro?: unknown; items?: Arranged[] }[] };
  const result = new Map<number, { intro: string | null; items: Arranged[] }>();
  for (const d of raw.days ?? []) {
    if (typeof d.index === "number" && Array.isArray(d.items))
      result.set(d.index, { intro: typeof d.intro === "string" ? d.intro : null, items: d.items });
  }
  return result;
}

// 重新排某一天（拖动、删除、添加、改时间、换交通方式、对话修改之后都走这里）：
// 1. 城际交通原样保留在开头和结尾；从城市出发、回到城市的那一段保留原来的起终点
// 2. 用餐补上餐厅（只补还没有的）
// 3. 按新顺序把相邻两个点（景点、餐厅、住宿）连成交通段：原来就有的段直接沿用，只有新出现的两点之间才查高德，
//    而且并行查询。所以只改时间、改停留时长时完全不用调用高德，删除一项也只需要查一段
// 4. 从这一天活动时间段的开始（默认 09:00）起按顺序排时间，最后重新判断负荷
export async function relayoutDay(
  day: ItineraryDay,
  order: ItineraryItem[],
  opts: { transport?: string | null; legModes?: Record<string, LegMode> } = {},
): Promise<ItineraryDay> {
  const isLocal = (x: ItineraryItem) =>
    x.kind === "transit" && (x.local ?? x.via?.startsWith("自驾") ?? false);
  const leading: ItineraryItem[] = [];
  for (const x of day.items) {
    if (x.kind === "transit" && !isLocal(x)) leading.push(x);
    else break;
  }
  const trailing: ItineraryItem[] = [];
  for (const x of [...day.items].reverse()) {
    if (x.kind === "transit" && !isLocal(x)) trailing.unshift(x);
    else break;
  }
  const existing = new Map(day.items.filter(isLocal).map((x) => [x.title, x]));

  // 当天开头 / 结尾的"城市 → 地点""地点 → 城市"段：起点、终点不是这一天的条目
  const pointOf = (x: ItineraryItem): GeoPoint | null => {
    if (x.kind === "free" && x.venue) return { name: x.venue.name, lng: x.venue.lng, lat: x.venue.lat };
    if ((x.kind === "place" || x.kind === "stay") && x.lng !== undefined && x.lat !== undefined)
      return { name: x.title, lng: x.lng, lat: x.lat };
    return null;
  };
  const names = new Set(
    day.items.flatMap((x) => [x.title, x.venue?.name]).filter((n): n is string => Boolean(n)),
  );
  const from = (x: ItineraryItem) => x.title.split(" → ")[0];
  const to = (x: ItineraryItem) => x.title.split(" → ")[1];
  const locals = day.items.filter(isLocal);
  const startLeg = locals.find((x) => !names.has(from(x)));
  const endLeg = [...locals].reverse().find((x) => !names.has(to(x)) && x !== startLeg);
  const endpoint = async (leg: ItineraryItem | undefined, side: "from" | "to") => {
    if (!leg) return null;
    const stored = leg.endpoints?.[side];
    if (stored) return stored;
    const name = side === "from" ? from(leg) : to(leg);
    const found = await geocode(name).catch(() => null);
    return found ? { name, lng: found.lng, lat: found.lat } : null;
  };
  const [startPoint, endPoint] = await Promise.all([endpoint(startLeg, "from"), endpoint(endLeg, "to")]);

  // 住宿固定在一天的最后（城际交通之前），不参与拖动
  const stays = day.items.filter((x) => x.kind === "stay");
  // 补上餐厅，再补上开放时间（景点和餐厅都要）
  const filled = await withHours(await withVenues([...order, ...stays]));
  const core = filled.filter((x) => x.kind !== "stay");

  // 先排出顺序，交通段先占位，再一起解析
  type Slot = { a: GeoPoint; b: GeoPoint };
  const seq: (ItineraryItem | Slot)[] = [];
  let prev: GeoPoint | null = startPoint;
  const visit = (x: ItineraryItem) => {
    const p = pointOf(x);
    if (p && prev && !samePlace(prev, p)) seq.push({ a: prev, b: p });
    seq.push(x);
    if (p) prev = p;
  };
  core.forEach(visit);
  if (endPoint && prev && !samePlace(prev, endPoint)) {
    seq.push({ a: prev, b: endPoint });
    prev = endPoint;
  }
  filled.filter((x) => x.kind === "stay").forEach(visit);

  const resolved = await Promise.all(
    seq.map(async (x) => {
      if ("kind" in x) return x;
      const title = `${x.a.name} → ${x.b.name}`;
      const wanted = opts.legModes?.[title];
      const old = existing.get(title);
      // 原来就有这一段，而且没有要求换方式：直接沿用。
      // 早期生成的段没有记录交通方式和坐标（一律算自驾），这种段交给 TT 按规则重新选，顺便拿到真实路线
      if (old?.mode && old.endpoints && (!wanted || wanted === old.mode)) return old;
      return chooseLeg({ from: x.a, to: x.b, city: day.city, transport: opts.transport, mode: wanted });
    }),
  );

  // 排时间：饭点不能太早（午餐最早 11:30，晚餐最早 17:30），到点之前的空档就等着；
  // 还没开门的也等到开门（最多等 1 小时，等更久就不等了，标出问题）；
  // 用户手动改过时间的条目（pinned）以用户的时间为准，比前一项结束得还早时标记为冲突；
  // 排好后逐项核对开放时间：关门后才到、关门时还没逛完、当天不开放，都记在 hoursIssue 里
  const earliest: Record<string, number> = { 午餐: 11 * 60 + 30, 晚餐: 17 * 60 + 30 };
  const window = dayWindow(day);
  let cursor = toMinutes(window.start);
  const items = [...leading, ...resolved, ...trailing].map((x) => {
    let conflict = false;
    if (x.kind !== "transit" && x.pinned && x.start) {
      const t = toMinutes(x.start);
      conflict = t < cursor;
      cursor = t;
    } else if (x.kind === "free" && earliest[x.title]) {
      cursor = Math.max(cursor, earliest[x.title]);
    }
    if (x.kind !== "transit" && x.kind !== "stay" && !x.pinned) {
      const open = earliestOpenStart(x.hours, cursor);
      if (open - cursor <= 60) cursor = open;
    }
    const start = x.kind === "transit" || x.kind === "stay" ? null : toClock(cursor);
    const hoursIssue = start ? checkVisit(x.hours, day.date, cursor, x.minutes) : null;
    cursor += x.minutes;
    return { ...x, start, conflict, hoursIssue };
  });
  const transitMinutes = items.filter((x) => x.kind === "transit").reduce((s, x) => s + x.minutes, 0);
  const playMinutes = items.filter((x) => x.kind !== "transit").reduce((s, x) => s + x.minutes, 0);
  return { ...day, items, transitMinutes, playMinutes, load: dayLoad(transitMinutes, playMinutes, window.minutes) };
}

// 单日详情里"添加景点"的候选：有关键词时在这座城市里搜；没有关键词时给出 LLM 提名、高德核实过的推荐。
// 推荐要调用一次大模型，同一座城市 10 分钟内复用结果
const suggestCache = new Map<string, { at: number; items: PoolItem[] }>();

export async function suggestPlaces(city: string, query: string, c: Constraints): Promise<PoolItem[]> {
  if (query.trim()) {
    const found = await searchInCity([query.trim()], city, 10).catch(() => []);
    return found
      .filter((p) => !/暂停营业|暂停开放|停业|已关闭/.test(p.name))
      .map((p) => ({ id: p.id, name: p.name, district: p.district, rating: p.rating, photo: p.photo, lng: p.lng, lat: p.lat, type: p.type }));
  }
  const key = `${city}|${[...c.hard, ...c.soft].map((x) => x.label).join(",")}`;
  const hit = suggestCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.items;
  const items = await verifiedAttractions(city, c);
  suggestCache.set(key, { at: Date.now(), items });
  return items;
}

// 餐厅候选：有关键词时在城市里搜，否则按距离找 10 家。
// meal 为某顿饭（换餐厅）：在这顿饭附近找，去掉当前这家；meal 为 null（"+ 用餐"新加一顿）：在这一天最后一个地点附近找
export async function nearbyRestaurants(day: ItineraryDay, meal: string | null, query: string): Promise<(PoolItem & { distanceM: number | null })[]> {
  const i = meal === null ? day.items.length : day.items.findIndex((x) => x.kind === "free" && x.title === meal);
  if (i < 0) return [];
  const current = meal === null ? null : day.items[i].venue;
  const near = mealReference(day.items, i);
  const found = query.trim()
    ? await searchInCity([query.trim()], day.city, 15)
    : near
      ? await searchAround(near, ["餐厅"], 1500, "050000", 10)
      : [];
  return found
    .filter((p) => p.type.includes("餐饮") && p.id !== current?.placeId && !/暂停营业|暂停开放|停业|已关闭/.test(p.name))
    .map((p) => ({ id: p.id, name: p.name, district: p.district, rating: p.rating, photo: p.photo, lng: p.lng, lat: p.lat, type: p.type, distanceM: p.distanceM }));
}

// 换住宿的候选：有关键词时在城市里搜，否则在现在的住处（没有就是这一天最后一个景点）附近按距离找 10 家
export async function nearbyHotels(day: ItineraryDay, query: string): Promise<(PoolItem & { distanceM: number | null })[]> {
  const current = day.items.find((x) => x.kind === "stay");
  const ref =
    current?.lng !== undefined
      ? current
      : [...day.items].reverse().find((x) => x.kind === "place" && x.lng !== undefined);
  const found = query.trim()
    ? await searchInCity([query.trim()], day.city, 15)
    : ref
      ? await searchAround({ lng: ref.lng!, lat: ref.lat! }, ["酒店"], 3000, "100100|100200", 10)
      : [];
  return found
    .filter((p) => p.type.includes("住宿服务") && p.id !== current?.placeId && !/暂停营业|暂停开放|停业|已关闭/.test(p.name))
    .map((p) => ({ id: p.id, name: p.name, district: p.district, rating: p.rating, photo: p.photo, lng: p.lng, lat: p.lat, type: p.type, distanceM: p.distanceM }));
}
