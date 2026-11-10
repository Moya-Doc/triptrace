import { cleanSuggestions, SUGGESTION_RULE } from "./suggestions";
import { chatJson, REPLY } from "./llm";
import { formatMinutes } from "./search";
import type { Candidate, ChatMessage, Constraints, RoutePlan } from "./types";

// ④ 表达：根据 ② 算出的事实，像真人顾问一样说话。
// LLM 只能引用事实表里的数据；地名、距离、车程一个字都不能自己编。

const SYSTEM_PROMPT = `你是 TripTrace，一位说话直接、靠谱的旅行顾问，像一个懂行的朋友在微信上回消息。输出 JSON：{"reply": 回复内容, "suggestions": [...]}。

## 回复结构
**只有在给出规划结论时才用三段式**：刚开始规划、有新的检索结果、或者路线计算的结论变了。
其他时候（回答一个问题、确认一个小改动、用户只是补充了一句、没有新结论）直接用一两句话回应，不要套三段式，也不要硬加方案和问题。

三段式：评价 → 提议 → 提问（段与段之间空一行）
1. **评价**：一两句话，先回应用户刚说的话，再给出你的判断，判断要有依据（引用检索结果或路线计算里的数字）。最关键的结论用 **加粗**
2. **提议**：2–3 个具体可选的方案或推荐，每个一行，以"- "开头，写清好处和代价；方案名或地点名用 **加粗**。没有可提议的就省略这一段
3. **提问**：最多 2 个问题，放在最后，整句用 **加粗**

## 说话方式
- 用户说"没问题"，就直接往下推进；用户改了条件，评价里先说一句你改了什么
- 不要每次都把需求完整复述一遍，用户知道自己说过什么
- **不要重复上一轮已经说过的内容**：上一轮给过的结论、数字、方案、提醒，这一轮不要再说一遍，只说这句话带来的新变化；如果没有新变化，就简短回应用户这句话
- 不要用"太棒了""好选择""这个想法太赞了"这类夸奖开场，直接说有用的内容
- 口语化，短句；只能用 **加粗** 和以"- "开头的列表这两种格式，不要用标题
- 总长度控制在 100–260 字

## 内容规则
1. **事实只能来自"检索结果"**：地点名、区县、车程、周边店名和距离，必须和检索结果一字不差。检索结果里没有的地点，一个都不能提。
   也不要对某个具体地点做检索结果之外的推测，例如"这里周末人多""名字带森林，氛围应该更好""风景更美"——这些你没法验证
2. 有检索结果时：挑 2–3 个最值得考虑的，每个说清楚**好在哪、代价是什么**。如果某个条件没满足，要直说。
   提到某个地点时，必须用它在检索结果里的 tag 作编号（例如 tag 是 ⑤ 就写 ⑤），因为地图上的图钉用的是同一套编号；不要自己重新编号
   shortlisted 为 true 的地点，是用户亲手拖进候选栏的：**优先围绕它们来比较和建议，先说它们**；其他地点只在明显更好、或者能补上它们的短板时再提
3. memory_used 不为空、且这是新需求（user_act 为 new_need）时：**第一句话就说明你从灵感池里想起了什么、所以这样理解**，例如"你之前说过想在成都周边登山露营，我先按这个方向找"。让用户知道你为什么这样推荐，也方便用户说"不是这个"。后续轮次不要重复
   "假设"槽位（source 为 assumed）：用一句话说出你的假设，例如"我先按自驾、两三个朋友来考虑，不对你说"。已经说过的假设，后面就不要再重复
4. "待问"的问题：最多问 2 个，放在最后。上一轮已经问过、用户还没回答的问题，这一轮不要原样再问；用户可能是想先看看结果，可以不问，或者换个说法顺带一句
5. 主动补充一条用户没提到、但真人顾问会提醒的事，比如季节、天气、装备、预约。只能说常识，用"一般来说"这类说法，不要给具体的数字
6. "暂无数据验证"的偏好（例如人少）：如实说你没法验证，不要假装知道
7. 没有检索结果时：不要推荐任何具体地点
8. 可行性检查（feasibility_check）：只根据"路线计算"里的数据下结论。
   - 替代方案用"方案 A / B / C"编号，不要用 ①②③，因为地图上的城市已经用数字编号了
   - verdict 为 overloaded：第一句话就直说太赶，引用转场总时长和占比，然后给 2–3 个替代方案（例如减一座城、加天数、调整顺序），各说代价
   - verdict 为 tight：说偏紧，指出最长的一段
   - verdict 为 relaxed：说可行，提醒注意事项
   - verdict 为 unknown（不知道天数）：给出各段交通时间，问天数，不下结论
   - unresolved 里的地点（例如境外城市）没有算进去，要明说"这一段没算进去"，比如国际航班和倒时差
   - 有"假设原路返回"的段：用一句话说明这个假设，并问一句是不是从别处返程
   - 没有路线计算数据时，不要下"太赶"或"不赶"的结论
10. 不要说"这一轮我没查""先不报地名"这类内部过程，用户不关心系统做了什么，只关心结论和下一步
11. 需求内部有矛盾（conflicts）时，坦率地说出来

## 快捷回复
${SUGGESTION_RULE}`;

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];

export async function respond(input: {
  messages: ChatMessage[];
  constraints: Constraints;
  candidates: Candidate[];
  searched: boolean;
  edit?: string;
  kickoff?: boolean;
  shortlist: Candidate[];
  route: RoutePlan | null;
  itineraryReady?: boolean;
}): Promise<{ reply: string; suggestions: string[] }> {
  const { messages, constraints: c, candidates, searched, edit, kickoff, shortlist, route, itineraryReady } = input;
  const conversation = messages
    .slice(-6)
    .map((m) => `${m.role === "user" ? "用户" : "TripTrace"}：${m.content}`)
    .join("\n");

  // 事实表 = 排名前 5 + 用户放进候选栏的地点（可能来自更早的检索，不在这一轮结果里）
  const shortlistIds = new Set(shortlist.map((x) => x.id));
  const current = new Map(candidates.map((x) => [x.id, x]));
  const pool = [
    ...shortlist.map((x) => current.get(x.id) ?? { ...x, rank: 0 }),
    ...candidates.slice(0, 5).filter((x) => !shortlistIds.has(x.id)),
  ];
  const facts = pool.map((x) => ({
    // 不在本轮结果里的候选地点，地图上没有编号，用 ☆ 表示
    tag: x.rank ? CIRCLED[x.rank - 1] : "☆",
    shortlisted: shortlistIds.has(x.id),
    name: x.name,
    district: x.district,
    rating: x.rating,
    checks: x.checks.map((ch) => `${ch.ok ? "✓" : "✗"} ${ch.label}：${ch.detail}`),
  }));

  const content = [
    `今天是 ${new Date().toISOString().slice(0, 10)}。`,
    `对话记录：\n${conversation}`,
    itineraryReady
      ? "逐日行程已经生成好了，在右边。用户这句话不是在调整某一天的安排：是提问就直接回答；是改了整体条件（目的地、日期等），说一句你改了什么，告诉用户行程会按新条件重新排。不要再给方案 A/B/C"
      : "",
    edit ? `用户刚刚在右侧的路书上做了修改：${edit}。用一句话回应这个修改，再给出新的结果` : "",
    kickoff
      ? "这是规划的第一条消息：用户刚在首页聊完，点了“开始规划”，你已经把首页对话里的信息填进了右侧的路书。先用一句话说明填了哪些，再按规则给结果或追问。不要说“你好”"
      : "",
    `当前需求：${JSON.stringify({
      intent: c.intent,
      user_act: c.user_act,
      summary: c.summary,
      time_window: c.time_window,
      dates: c.start_date && c.end_date ? `${c.start_date} 至 ${c.end_date}` : null,
      days: c.days,
      extra: c.extra,
      origin: c.origin,
      slots: c.slots,
      memory_used: c.memory_used,
      unverifiable: c.soft.filter((s) => s.type === "preference").map((s) => s.label),
      conflicts: c.conflicts,
      to_ask: c.missing.map((m) => m.question),
    })}`,
    searched
      ? facts.length
        ? `检索结果（来自高德地图，已按满足的条件数排序）：\n${JSON.stringify(facts)}`
        : "检索结果：按当前条件没有找到合适的地点。"
      : "检索结果：本轮没有检索。",
    route
      ? `路线计算（来自高德公共交通路线规划，门到门时间，已含高铁）：${JSON.stringify({
          legs: route.legs.map((l) => ({
            段: `${l.from} → ${l.to}${l.assumed ? "（用户没说返程地，假设原路返回）" : ""}`,
            时间: l.minutes === null ? "没查到" : formatMinutes(l.minutes),
            方式: l.via,
          })),
          转场总时长: formatMinutes(route.transferMinutes),
          可活动时间: route.availableHours === null ? "未知" : `${route.availableHours} 小时（每天按 12 小时算）`,
          转场占比: route.transferShare === null ? "未知" : `${Math.round(route.transferShare * 100)}%`,
          verdict: route.verdict,
          unresolved: route.unresolved,
        })}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = (await chatJson([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content },
  ], REPLY)) as { reply?: unknown; suggestions?: unknown };
  if (typeof raw.reply !== "string" || !raw.reply.trim()) throw new Error("回复生成失败，请再试一次");
  return { reply: raw.reply.trim(), suggestions: cleanSuggestions(raw.suggestions) };
}

// 首页对话：发散模式。像朋友一样接住念头，帮它慢慢成形；这里没有地图数据，不推荐具体地点
const HOME_PROMPT = `你是 TripTrace，用户在首页随口聊旅行念头，你像一个懂旅行的朋友在微信上回消息。输出 JSON：{"reply": 回复内容}。

- 先接住用户刚说的话，口语化、短句，40–120 字，不要用 Markdown
- 不要推荐具体的景点、营地、酒店（这里没有地图数据，推荐了也没法核对）
- 可以顺着念头问一个问题，帮它更具体（比如想去哪一带、想做什么、大概什么时候），一次只问一个
- 灵感池里用户以前说过的话，和这次相关时可以自然地提一句，例如"你上次也说过想吃烤全羊"。只能引用用户原话里明确说过的
- 如果 ready 为 true，最后提醒一句：觉得差不多了，可以点输入框上方的"开始规划"，你会把路书填好
- 不要用"太棒了""好选择"之类的夸奖开场`;

export async function respondHome(input: {
  messages: ChatMessage[];
  constraints: Constraints;
  ready: boolean;
}): Promise<string> {
  const { messages, constraints: c, ready } = input;
  const conversation = messages
    .slice(-8)
    .map((m) => `${m.role === "user" ? "用户" : "TripTrace"}：${m.content}`)
    .join("\n");
  const raw = (await chatJson([
    { role: "system", content: HOME_PROMPT },
    {
      role: "user",
      content: [
        `今天是 ${new Date().toISOString().slice(0, 10)}。`,
        `对话记录：\n${conversation}`,
        `理解到的念头：${JSON.stringify({ summary: c.summary, memory_used: c.memory_used, conflicts: c.conflicts })}`,
        `ready：${ready}`,
      ].join("\n\n"),
    },
  ], REPLY)) as { reply?: unknown };
  if (typeof raw.reply !== "string" || !raw.reply.trim()) throw new Error("回复生成失败，请再试一次");
  return raw.reply.trim();
}
