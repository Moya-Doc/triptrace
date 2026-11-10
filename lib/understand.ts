import type { InspirationCard } from "./db";
import { chatJson } from "./llm";
import { Constraints, withDaysFromDates, type ChatMessage } from "./types";

// ① 理解：把对话变成结构化约束，并按"路书核对清单"逐项检查。
// 有上一轮的约束时，LLM 在它的基础上修改，这样"不想开那么久的车"这类修正也走同一条路。

const SYSTEM_PROMPT = `你是旅行助手 TripTrace 的"需求理解"模块。你的唯一任务：把用户的旅行想法拆成结构化约束，并按路书核对清单逐项检查，输出 JSON。

## 输出字段
- intent："choose_destination"（想找去哪里）| "feasibility_check"（已经定了要去的城市，想排行程）| "other"（与旅行规划无关）
- user_act：用户最新这句话在做什么。"new_need" 提出新需求 | "refine" 补充或修改条件 | "confirm" 确认、同意、让你继续（如"没问题""好的""可以"）| "question" 在问你问题 | "chitchat" 闲聊
- summary：用一句话复述你理解的需求，口语化
- anchor：用户提到的参照城市，例如"在成都附近"中的"成都"；没有就是 null
- origin：出发地；用户没说就是 null，不要猜
- days：天数；没说就是 null
- time_window：出行时间的原话，例如"十一""这周末""11 月中旬"；没说就是 null
- start_date / end_date：把出行时间换算成具体日期（YYYY-MM-DD），以"今天"为准推算，例如"这周末"是最近的周六和周日。只知道天数、不知道哪天出发时，两个都是 null；没说时间也是 null
- slots：路书中的"重要"槽位，每个都是 {"value":字符串或null,"source":"user"|"assumed"|null}
  · companions 同行人；transport 交通方式（自驾 / 公共交通 / 飞机）；budget 预算档位；pace 节奏；lodging 住宿偏好（露营 / 民宿 / 酒店等）
  · 用户说了的，source 为 "user"
  · 用户没说、但和这次需求相关的，给出最常见的合理假设，source 为 "assumed"。例如去城市周边露营，transport 假设"自驾"，companions 假设"两三个朋友"
  · 和这次需求无关的，value 和 source 都是 null
- hard：硬约束，必须满足。只有一种类型：
  {"type":"activity","keywords":[适合在地图里搜索的地点类型名词],"label":给用户看的短标签}
  keywords 要写成地图能搜到的地点名词，例如"露营地""营地""海滩""温泉"，不要写"登山露营"这种动作
- soft：软约束，满足了更好。用户说"最好""就更好了""希望"的都是软约束。三种类型：
  {"type":"nearby_poi","keywords":[...],"radius_km":数字,"label":...}：候选地点附近要有某类地点，keywords 用店名里常出现的词
  {"type":"max_drive_time","from":城市,"hours":数字,"label":...}："在 X 附近"默认理解为从 X 出发 2 小时车程内
  {"type":"preference","label":...}：没有可靠数据可以验证的偏好，例如"人少""小众""安静""不商业化"
- cities：intent 为 feasibility_check 时，按顺序列出要去游玩的城市；否则为 []。
  出发地不算要去的城市：用户说"从西安到成都"，origin 是"西安"，cities 是 ["成都"]，不是 ["西安","成都"]。
  "从 X 到 Y""从 X 去 Y"的意思是：出发地是 X，这次要去的就是 Y。即使之前说过别的城市，也要把 cities **替换**成 Y；
  只有用户明确说"再去""顺便""加上"时，才保留原来的城市
- search_regions：intent 为 choose_destination 时，列出 3–5 个**最可能满足硬约束**的区县或城市名。
  要结合活动的特点来选，例如登山露营应选山区的区县（成都周边可选都江堰、彭州、大邑、崇州），而不是市中心；看海应选沿海城市。其他情况为 []
- missing：最多 2 个必须问用户的问题，格式 {"field":字段名,"question":问题}。只问"必须层"的信息：
  · 出行时间或天数（time_window 和 days 都是 null 时）
  · 出发地（choose_destination 且 anchor 和 origin 都是 null 时）
  · feasibility_check 且 origin 是 null 时，用一个问题同时问"从哪里出发、在哪里返程"
  重要层的槽位不要问，用假设代替
- memory_used：这次从"灵感池"里用上了哪些旧念头，每条一句话，写清楚用了什么、来自哪天，例如"出发地成都（11 月 2 日的露营规划里提过）"。没用上就是 []
- extra：用户提到的、放不进其他字段的额外需求，一句话；没有就是 null。如果给了"当前约束"且其中已有 extra，保留并按新消息更新
- conflicts：用户需求**内部互相矛盾**的地方，例如"十一假期"和"人少"很难同时满足；没有就是 []。
  不要在这里判断"时间够不够、路程远不远"，那需要真实的交通数据，由计算模块负责

## 灵感池（用户过去的旅行念头）
如果给了"灵感池"，它是用户在其他规划里说过的话。可以用它来：
  · 补全用户这次没说的槽位和出发地，例如过去总是从成都出发；槽位的 source 写 "memory"
  · 用户这次的需求很模糊时（如"周末想出去走走"），参考灵感池里反复出现的兴趣来理解
但要克制：只用和这次需求明显相关的；用户这次说的永远优先；不要把旧念头里的条件硬塞进 hard。每用一条都要写进 memory_used。
标了【旅行回顾】的是用户上一次旅行回来后亲口说的"哪里喜欢、哪里后悔"，是亲身经历得出的偏好（例如"后悔坐火车太久，下次想直接飞"）。
这次的需求遇到同样的情况（同样的出发地、交通方式、节奏）时，要用上：可以作为槽位的默认值（source 写 "memory"），并写进 memory_used
只有用户原话里明确说过的，才能当作记忆使用；不要从原话里推测出用户没说过的偏好。

## 规则
1. 不要输出任何坐标、距离、时间估算或具体景点推荐，那是其他模块的工作。
2. 如果给了"当前约束"，说明这是后续对话：在当前约束的基础上，根据用户的新消息修改，并输出修改后的完整约束。用户说"这次不想……"时，只调整本次的约束。用户只是确认或提问时，约束保持不变。
3. 只输出 JSON，不要输出其他文字。`;

const EXAMPLE_INPUT = "想找个可以登山露营的地方，最好附近可以吃到烤全羊，在成都附近就更好了";
const EXAMPLE_OUTPUT = {
  intent: "choose_destination",
  user_act: "new_need",
  summary: "想在成都周边找一个能登山露营的地方，附近最好能吃到烤全羊",
  anchor: "成都",
  origin: null,
  days: null,
  time_window: null,
  slots: {
    companions: { value: "两三个朋友", source: "assumed" },
    transport: { value: "自驾", source: "assumed" },
    budget: { value: null, source: null },
    pace: { value: "轻松", source: "assumed" },
    lodging: { value: "露营", source: "user" },
  },
  hard: [{ type: "activity", keywords: ["露营地", "营地"], label: "登山露营" }],
  soft: [
    { type: "nearby_poi", keywords: ["烤全羊"], radius_km: 10, label: "附近有烤全羊" },
    { type: "max_drive_time", from: "成都", hours: 2, label: "成都 2 小时车程内" },
  ],
  cities: [],
  search_regions: ["都江堰", "彭州", "大邑", "崇州"],
  missing: [{ field: "time", question: "打算什么时候去、玩几天？" }],
  conflicts: [],
  start_date: null,
  end_date: null,
  extra: null,
  memory_used: [],
};

export async function understand(
  messages: ChatMessage[],
  current: Constraints | null,
  memory: InspirationCard[] = [],
): Promise<Constraints> {
  const today = new Date().toISOString().slice(0, 10);
  const conversation = messages
    .slice(-8)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
    .join("\n");

  const memoryText = memory.length
    ? `灵感池（新的在前）：\n${memory
        .map((m) => {
          const tags = [...m.activities, ...m.preferences].join("、");
          // 只给用户的原话，不给模型自己写的复述：复述里可能混着 TT 当时的假设（如"节奏轻松"），
          // 存进记忆后会被当成"你之前说过"，这叫记忆污染
          return `- ${m.createdAt.slice(0, 10)}，${m.source === "reflection" ? "【旅行回顾】" : ""}用户原话："${m.rawText}"${tags ? `（${tags}）` : ""}${m.status === "已实现" ? "【已去过】" : ""}`;
        })
        .join("\n")}`
    : "灵感池：空";

  const userContent = [
    `今天是 ${today}。`,
    memoryText,
    current ? `当前约束：\n${JSON.stringify(current)}` : "当前约束：无（这是新的需求）",
    `对话记录：\n${conversation}`,
  ].join("\n\n");

  const prompt = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: `今天是 2026-11-02。\n\n当前约束：无（这是新的需求）\n\n对话记录：\n用户：${EXAMPLE_INPUT}` },
    { role: "assistant" as const, content: JSON.stringify(EXAMPLE_OUTPUT) },
    { role: "user" as const, content: userContent },
  ];

  // 格式不对时，把校验错误告诉模型，让它重来一次
  let raw = await chatJson(prompt);
  let parsed = Constraints.safeParse(raw);
  if (!parsed.success) {
    raw = await chatJson([
      ...prompt,
      { role: "assistant", content: JSON.stringify(raw) },
      {
        role: "user",
        content: `你的输出不符合格式要求：${parsed.error.message.slice(0, 500)}。请修正后重新输出完整 JSON。`,
      },
    ]);
    parsed = Constraints.safeParse(raw);
  }
  if (!parsed.success) {
    throw new Error("没能理解这句话，请换一种说法试试");
  }
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  return withDaysFromDates(dropOriginFromCities(applyFromTo(lastUser, parsed.data)));
}


// 首页对话是否已经可以开始规划：有了方向（参照城市、要去的城市，或者明确想做的事）。
// 用规则判断而不是让模型判断：结果稳定，也能解释"按钮为什么出现"
export { withDaysFromDates };

// 兜底：模型偶尔仍会把出发地写进要去的城市（"从西安到成都"→ ["西安","成都"]），这里用代码去掉。
// 去掉开头的出发地（出发）和结尾的出发地（返程，返程段由路线计算自动补上）；
// 如果城市只剩出发地一个，说明用户就是要在出发地玩，保留
// "从 X 到 Y"是能用规则确定的句式，不交给模型猜：模型有时会保留之前说过的其他城市。
// 只在多城路线里生效，Y 必须像城市名（2–6 个汉字，不含"附近""周边"之类的词）；
// 用户说"再去""顺便""加上"时表示保留原城市，不处理
export function applyFromTo(text: string, c: Constraints): Constraints {
  if (c.intent !== "feasibility_check" || /再去|顺便|加上|还要去/.test(text)) return c;
  const m = text.match(/从\s*([\u4e00-\u9fa5]{2,6}?)\s*(?:出发)?\s*(?:到|去)\s*([\u4e00-\u9fa5、，,和与\s]+)/);
  if (!m) return c;
  const cities = m[2]
    .replace(/[吧了啊呀呢。！]+$/, "")
    .replace(/(玩玩|玩|逛逛|看看|走走|转转)$/, "")
    .split(/[、，,和与\s]+/)
    .filter(Boolean);
  const cityLike = (t: string) => /^[\u4e00-\u9fa5]{2,6}$/.test(t) && !/附近|周边|一带|玩|看|吃|住/.test(t);
  if (!cities.length || !cities.every(cityLike)) return c;
  return { ...c, origin: m[1], cities };
}

export function dropOriginFromCities(c: Constraints): Constraints {
  if (!c.origin) return c;
  let cities = c.cities;
  if (cities.length > 1 && cities[0] === c.origin) cities = cities.slice(1);
  if (cities.length > 1 && cities[cities.length - 1] === c.origin) cities = cities.slice(0, -1);
  return cities === c.cities ? c : { ...c, cities };
}

export function readyToPlan(c: Constraints): boolean {
  return c.intent !== "other" && Boolean(c.anchor || c.cities.length || c.hard.length);
}

// 灵感卡片规则：只有出现新的旅行信息时才存（用户在自测中决定，2026-11-02）。
// 用代码比较约束有没有变化，而不是让 LLM 判断，这样结果稳定、可解释。
export function hasNewTravelInfo(prev: Constraints | null, next: Constraints): boolean {
  if (next.intent === "other") return false;
  if (!prev) return true;
  const fingerprint = (c: Constraints) =>
    JSON.stringify({
      hard: c.hard.map((h) => h.label),
      soft: c.soft.map((s) => s.label),
      anchor: c.anchor,
      origin: c.origin,
      days: c.days,
      time_window: c.time_window,
      dates: [c.start_date, c.end_date],
      cities: c.cities,
      userSlots: Object.entries(c.slots)
        .filter(([, s]) => s.source === "user")
        .map(([k, s]) => [k, s.value]),
    });
  return fingerprint(prev) !== fingerprint(next);
}
