import { chatJson, REPLY } from "./llm";
import { diffDay, hasNote, noteKey, UNPLANNED } from "./trip";
import type { ChatMessage, Departure, Itinerary, ItineraryItem, Journal, JournalDay, TripNote } from "./types";

// 旅行后的游记。分工和其他模块一样：
// - 代码整理事实：每天去了哪、几点、路上怎么走、旅行中临时改了什么（用户在"旅行中"说过的话）、照片（高德的）、统计数字
// - 用户在"旅行中"给某个地方写过记录的，那就是他自己的话：不再问，写游记时原样用上（照片也用他的）
// - LLM 只问没写记录的地方（按天一个问题），再只用"事实 + 记录 + 用户的回答"写游记；不替用户编感受，没回答的那天就平实地写
// - 最后一个问题固定由代码问："这次哪里最喜欢、哪里后悔"，回答写回灵感池

export const REFLECTION_QUESTION = "最后一个问题：这次旅行哪里最喜欢、哪里有点后悔？下次帮你规划时我会记着。";

type DayFacts = {
  index: number;
  date: string | null;
  city: string;
  stops: { time: string | null; name: string; kind: string; minutes: number; note: string | null }[];
  moves: string[];
  // 和出发时的计划比：取消了什么、路上新加了什么
  changes: string[];
  // 行程里没有的地方的记录（对话里说的"路过一家茶馆"）
  unplanned: string | null;
};

type Notes = Record<string, TripNote>;

// 去过的地方按天判断：那天打过勾的，以打勾为准（写过记录的也算去过）；一天都没打勾（用户常常懒得勾），就按计划算。
// 只写了一条记录不算"打勾"：否则这一天别的地方都会被当成没去
export function journalFacts(itinerary: Itinerary, notes: Notes = {}, departure: Departure | null = null) {
  const days: DayFacts[] = itinerary.days.map((d) => {
    const noted = (x: ItineraryItem) => hasNote(notes[noteKey(d.index, x.title)]);
    const marked = (x: ItineraryItem) => Boolean(x.done) || noted(x);
    const dayDone = d.items.some((x) => x.done && (x.kind === "place" || x.kind === "free"));
    const visited = (x: ItineraryItem) => (dayDone ? marked(x) : true);
    const diff = diffDay(d, departure?.itinerary.days.find((b) => b.index === d.index));
    return {
    index: d.index,
    date: d.date,
    city: d.city,
    stops: d.items
      .filter((x) => (x.kind === "place" || x.kind === "free") && visited(x))
      .map((x) => ({
        time: x.start,
        name: x.venue ? `${x.title}（${x.venue.name}）` : x.title,
        kind: x.kind === "free" ? (x.venue ? "吃饭" : "活动") : "景点",
        minutes: x.minutes,
        note: notes[noteKey(d.index, x.title)]?.text.trim() || null,
      })),
    moves: d.items
      .filter((x) => x.kind === "transit")
      .map((x) => `${x.title}（${x.local ? (x.mode ?? "drive") : (x.via ?? "城际")}，${x.minutes} 分钟）`),
    unplanned: notes[noteKey(d.index, UNPLANNED)]?.text.trim() || null,
    changes: [
      ...diff.removed.map((x) => `原计划的「${x.title}」取消了`),
      ...[...diff.added].map((t) => `路上新加了「${t}」`),
    ],
    };
  });
  return { days };
}

export function journalStats(itinerary: Itinerary): Journal["stats"] {
  const legs = itinerary.days.flatMap((d) => d.items.filter((x) => x.kind === "transit" && x.local));
  const km = (list: ItineraryItem[]) => Math.round(list.reduce((s, x) => s + (x.distanceM ?? 0), 0) / 100) / 10;
  return {
    days: itinerary.days.length,
    cities: new Set(itinerary.days.map((d) => d.city)).size,
    places: itinerary.days.reduce((s, d) => s + d.items.filter((x) => x.kind === "place").length, 0),
    walkKm: km(legs.filter((x) => x.mode === "walk")),
    rideKm: km(legs.filter((x) => x.mode !== "walk")),
  };
}

// 每天的照片：路上记录里自己拍的放最前面（长图里每天用第一张），不够 4 张再用高德的景点 / 餐厅照片（标注来源）
export function defaultPhotos(itinerary: Itinerary, dayIndex: number, notes: Notes = {}) {
  const day = itinerary.days.find((d) => d.index === dayIndex);
  const own = [...(day?.items ?? []).map((x) => x.title), UNPLANNED].flatMap((title) =>
    (notes[noteKey(dayIndex, title)]?.photos ?? []).map((url) => ({ url, source: "user" as const, caption: title })),
  );
  const amap = (day?.items ?? [])
    .map((x) => (x.kind === "place" ? { url: x.photo, caption: x.title } : x.venue ? { url: x.venue.photo, caption: x.venue.name } : null))
    .filter((p): p is { url: string; caption: string } => Boolean(p?.url))
    .slice(0, Math.max(0, 4 - own.length))
    .map((p) => ({ url: p.url, source: "amap" as const, caption: p.caption }));
  return [...own, ...amap];
}

const QUESTION_PROMPT = `你是 TripTrace，用户刚旅行回来，你要帮他写游记。给下面列出的每一天各问一个问题，让用户说出自己的感受或印象最深的事。输出 JSON：{"questions":[{"day":天的序号,"question":"问题"}, ...]}

- 每天一个问题，按天的顺序；问题要具体到那天"没写记录"的地方（例如"第 2 天在熊猫基地，有没有哪只熊猫或者哪个瞬间让你印象最深？"）
- "已写记录"的地方用户路上已经写过了，不要再问；可以参考记录的内容，避免问重复的
- 那天路上有过临时调整的（"路上的情况"），可以顺着问（例如"下雨换成博物馆之后，感觉怎么样？"）
- 口语化，每个问题不超过 35 个字；不要假设用户的感受（不要问"是不是很开心"）`;

// 只问没写记录的地方：一天里每个地方都写过记录，这一天就不问了
export async function askQuestions(itinerary: Itinerary, live: ChatMessage[], notes: Notes = {}, departure: Departure | null = null) {
  const facts = journalFacts(itinerary, notes, departure);
  const pending = facts.days.filter((d) => d.stops.some((s) => !s.note));
  if (!pending.length) return [];
  const raw = (await chatJson([
    { role: "system", content: QUESTION_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        days: pending.map((d) => ({
          day: d.index + 1,
          city: d.city,
          没写记录: d.stops.filter((s) => !s.note).map((s) => s.name),
          已写记录: d.stops.filter((s) => s.note).map((s) => `${s.name}：${s.note}`),
        })),
        路上的情况: live.filter((m) => m.role === "user").map((m) => m.content).slice(-10),
      }),
    },
  ], REPLY)) as { questions?: { day?: unknown; question?: unknown }[] };
  const asked = new Map(
    (Array.isArray(raw.questions) ? raw.questions : [])
      .filter((q) => typeof q?.question === "string")
      .map((q) => [Number(q.day), String(q.question).trim()]),
  );
  // 漏掉的天用通用的问题补齐
  return pending.map((d) => asked.get(d.index + 1) || `第 ${d.index + 1} 天在${d.city}，印象最深的是什么？`);
}

const JOURNAL_PROMPT = `你是 TripTrace，根据"事实"和"用户的回答"，用用户的口吻（第一人称"我"）写一篇按天组织的游记。输出 JSON：
{"title":"游记标题，不超过 16 个字","summary":"开头一两句，概括这趟旅行","days":[{"day":第几天（和事实里的 day 一致，从 1 开始）,"title":"这一天的小标题，不超过 12 个字","text":"这一天的正文"}]}

- **只能写事实里有的地方、时间、交通，和用户自己的话（路上的记录 note、回答）**。用户没说的感受不要编（不要写"美极了""非常难忘"这类用户没说过的话）
- 地方带有 note 的、以及"计划外的记录"，都是用户在路上写的或说的：**原话写进正文**，只能补标点、加"上午先去了……"这类连接，不改写、不删减
- "和计划的不同"是出发后实际发生的变化（取消、新加），自然地写进去
- "路上的情况"是用户旅行中说过的话（比如"下雨了"），可以作为背景；去了哪、取消了什么只以事实为准
- 用户对 TT 说的要求（"帮我把晚餐推迟半小时""后面帮我压缩一下"）不是游记内容，不要写进正文
- 既没有记录、也没有回答的地方：只写去了、几点、怎么去的，不要补"随便转了转"这类细节
- 用户跳过了那天的问题、也没写记录：就平实地写去了哪、怎么走的，不加感受
- 路上临时改过的安排（"路上的情况"）要写进去，这是这趟旅行真实的样子
- 每天的正文 60–150 字（记录很长时可以更长，以保留原话为准），自然、口语，像发在朋友圈或小红书的那种；不要用列表和标题`;

export async function writeJournal(input: {
  itinerary: Itinerary;
  title: string;
  live: ChatMessage[];
  qa: { question: string; answer: string | null }[];
  notes?: Notes;
  departure?: Departure | null;
}): Promise<Journal> {
  const { itinerary, live, qa, notes = {}, departure = null } = input;
  const facts = journalFacts(itinerary, notes, departure);
  const raw = (await chatJson([
    { role: "system", content: JOURNAL_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        事实: facts.days.map((d) => ({
          day: d.index + 1,
          date: d.date,
          city: d.city,
          stops: d.stops,
          moves: d.moves,
          和计划的不同: d.changes,
          计划外的记录: d.unplanned,
        })),
        // 只给用户自己说的话：TT 的提议用户可能没同意，给了模型容易写成"发生过"
        路上的情况: live.filter((m) => m.role === "user").map((m) => m.content).slice(-12),
        用户的回答: qa.map((x) => ({ 问题: x.question, 回答: x.answer ?? "（跳过）" })),
      }),
    },
    // 游记要保留用户原话、不编感受：随机性比普通回复低一些
  ], { temperature: 0.4 })) as { title?: unknown; summary?: unknown; days?: { day?: unknown; title?: unknown; text?: unknown }[] };
  // 模型按"第几天"（从 1 开始）返回，这里换回从 0 开始的序号
  const written = new Map((raw.days ?? []).map((d) => [Number(d.day) - 1, d]));
  const days: JournalDay[] = facts.days.map((d) => {
    const w = written.get(d.index);
    return {
      index: d.index,
      date: d.date,
      city: d.city,
      title: typeof w?.title === "string" && w.title ? w.title : `第 ${d.index + 1} 天 · ${d.city}`,
      places: d.stops.map((s) => s.name),
      photos: defaultPhotos(itinerary, d.index, notes),
      text: typeof w?.text === "string" ? w.text : d.stops.map((s) => s.name).join("、"),
    };
  });
  const now = new Date().toISOString();
  return {
    title: typeof raw.title === "string" && raw.title ? raw.title : input.title,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    days,
    stats: journalStats(itinerary),
    createdAt: now,
    updatedAt: now,
  };
}
