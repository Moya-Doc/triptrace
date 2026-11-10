import { chatJson } from "./llm";
import { whereText, type LiveState } from "./live";
import { noteKey, stopsOf, UNPLANNED } from "./trip";
import type { Itinerary, ItineraryItem, TripNote } from "./types";

// 旅行中对话里的"感受和经历"（看到了什么、吃了什么、玩得怎样）：自动记进对应地方的记录，回来写游记时用上。
// 分工：
// - LLM 只做两件事：从这句话里摘出感受（原话片段），以及"刚才那家店"这类指代对应行程里的哪一项
// - 地点先用代码匹配（地点名、餐厅名和它们的简称），代码对不上才用 LLM 的判断，而且只能是行程里有的
// - 代码核对位置：说的是排在"现在所在地方"之后的（10:00 还在武侯祠，却说锦里逛得挺开心），先不记，问用户是不是已经到了

// 一条感受，放在哪：第几天的哪一项；title 为"计划外"表示行程里没有的地方
export type Moment = { text: string; day: number; title: string; start: string | null; conflict: boolean };

const SUFFIX = /(博物馆|博物院|古街|老街|风景名胜区|风景区|景区|公园|古镇|广场)$/;

// 一个地方的几种叫法：全名、去掉括号里的分店名、去掉城市名前缀、去掉"博物馆 / 古街"这类后缀
function namesOf(x: ItineraryItem, city: string) {
  const full = [x.kind === "place" ? x.title : null, x.venue?.name ?? null].filter((n): n is string => Boolean(n));
  const forms = new Set<string>();
  for (const n of full) {
    const bare = n.replace(/[(（].*?[)）]/g, "").trim();
    const noCity = bare.startsWith(city) ? bare.slice(city.length) : bare;
    for (const f of [n, bare, noCity, noCity.replace(SUFFIX, "")]) if (f.length >= 2 && f !== city) forms.add(f);
  }
  return [...forms];
}

type Spot = { day: number; title: string; start: string | null; order: number; names: string[] };

function spotsOf(itinerary: Itinerary): Spot[] {
  return itinerary.days.flatMap((d) =>
    stopsOf(d).map((x, order) => ({ day: d.index, title: x.title, start: x.start, order, names: namesOf(x, d.city) })),
  );
}

// 代码匹配：话里出现了某个地方的名字或简称。今天的优先；有多个就取话里最先出现的
function codeMatch(text: string, spots: Spot[], today: number) {
  const hits = spots
    .map((s) => ({ s, pos: Math.min(...s.names.map((n) => (text.includes(n) ? text.indexOf(n) : Infinity))) }))
    .filter((h) => h.pos !== Infinity)
    .sort((a, b) => Number(b.s.day === today) - Number(a.s.day === today) || a.pos - b.pos);
  return hits[0]?.s ?? null;
}

const PROMPT = `用户正在旅行中，下面是他刚说的一句话。找出其中的"感受或经历"：看到了什么、吃了什么、玩得怎样、心情如何。
不算：让 TT 改行程的要求、提问、单纯报告状况（"下雨了""我晚了""这里关门了""好，改吧"）。
输出 JSON：{"moments":[{"text":"用户的原话片段","place":"条目名 / 计划外 / null"}]}
- text 必须摘自用户的原话，不改写、不总结；要完整到单独拿出来也读得懂，说到的地方名要带上（"路过一家盖碗茶馆，坐了会儿很舒服"整句都要，不能只留"坐了会儿很舒服"）；去掉其中让 TT 改行程的部分；同一个地方的感受合成一条
- place：说到或指代行程里的地方（包括"刚才那家店""那个博物馆"这类指代），填条目名，必须从"行程"里原样照抄；说的是行程里没有的地方，填"计划外"；没说具体地方，填 null
- 没有感受或经历就输出 {"moments":[]}`;

export async function findMoments(text: string, itinerary: Itinerary, s: LiveState): Promise<Moment[]> {
  const spots = spotsOf(itinerary);
  const day = itinerary.days.find((d) => d.index === s.day);
  const raw = (await chatJson([
    { role: "system", content: PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        现在: `第 ${s.day + 1} 天 ${s.now}，${whereText(s)}`,
        行程: itinerary.days.map((d) => ({
          day: d.index + 1,
          条目: stopsOf(d).map((x) => (x.venue ? `${x.title}（${x.venue.name}）` : x.title)),
        })),
        用户的话: text,
      }),
    },
  ])) as { moments?: { text?: unknown; place?: unknown }[] };
  const atOrder = day ? stopsOf(day).findIndex((x) => x.title === s.at) : -1;
  const moments: Moment[] = [];
  for (const m of Array.isArray(raw.moments) ? raw.moments : []) {
    if (typeof m?.text !== "string" || !m.text.trim()) continue;
    const said = m.text.trim();
    const place = typeof m.place === "string" ? m.place.replace(/（.*）$/, "").trim() : null;
    // 先看话里有没有地名（代码），再看 LLM 的指代判断（必须是行程里有的），都没有就记在现在所在的地方
    const spot =
      codeMatch(said, spots, s.day) ??
      codeMatch(text, spots, s.day) ??
      (place ? (spots.find((x) => x.title === place && x.day === s.day) ?? spots.find((x) => x.title === place)) : undefined) ??
      null;
    if (!spot && place === UNPLANNED) {
      moments.push({ text: said, day: s.day, title: UNPLANNED, start: null, conflict: false });
      continue;
    }
    const target = spot ?? spots.find((x) => x.day === s.day && x.title === s.at);
    if (!target) continue;
    // 排在现在所在地方之后：今天还没到的，或者以后的日子
    const conflict = target.day > s.day || (target.day === s.day && atOrder >= 0 && target.order > atOrder);
    moments.push({ text: said, day: target.day, title: target.title, start: target.start, conflict });
  }
  return moments;
}

// 把感受追加进记录（标"来自对话"）；同样的话已经记过就不再重复
export function addMoments(notes: Record<string, TripNote>, moments: Moment[]) {
  const next = { ...notes };
  for (const m of moments) {
    const key = noteKey(m.day, m.title);
    const old = next[key];
    if (old?.text.includes(m.text)) continue;
    next[key] = {
      text: old?.text.trim() ? `${old.text.trim()}\n${m.text}` : m.text,
      photos: old?.photos ?? [],
      fromChat: true,
      updatedAt: new Date().toISOString(),
    };
  }
  return next;
}

// 回复末尾的一句："已记到「锦里古街」的记录里"
export function momentLine(moments: Moment[]) {
  const places = [...new Set(moments.map((m) => (m.title === UNPLANNED ? "今天的计划外" : `「${m.title}」`)))];
  return places.length ? `📝 已记到${places.join("、")}的记录里，在右边的时间轴上可以改。` : "";
}
