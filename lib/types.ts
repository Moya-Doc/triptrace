import { z } from "zod";

// ① 理解步骤的输出：把一句大白话拆成结构化约束。
// LLM 只负责填这张表，不生成任何坐标、距离或时间。

export const HardConstraint = z.object({
  type: z.literal("activity"),
  // 适合直接拿去高德做关键字搜索的词，例如 "露营地"
  keywords: z.array(z.string()).min(1),
  label: z.string(),
});

export const SoftConstraint = z.discriminatedUnion("type", [
  // 候选地点附近 radius_km 公里内要有某类地点，例如烤全羊
  z.object({
    type: z.literal("nearby_poi"),
    keywords: z.array(z.string()).min(1),
    radius_km: z.number().positive(),
    label: z.string(),
  }),
  // 从某地出发的车程上限
  z.object({
    type: z.literal("max_drive_time"),
    from: z.string(),
    hours: z.number().positive(),
    label: z.string(),
  }),
  // 没有可靠数据可以验证的偏好，例如"人少"；只展示，不参与计算
  z.object({
    type: z.literal("preference"),
    label: z.string(),
  }),
]);

export const MissingInfo = z.object({
  field: z.string(),
  question: z.string(),
});

// 路书核对清单中"重要层"的槽位：用户给出的，或者 TT 先做的假设
export const Slot = z.object({
  value: z.string().nullable(),
  // memory：来自灵感池里的旧念头
  source: z.enum(["user", "assumed", "memory"]).nullable(),
});

export const Constraints = z.object({
  intent: z.enum(["choose_destination", "feasibility_check", "other"]),
  // 用户这句话在做什么：提出新需求 / 修改 / 确认 / 提问 / 闲聊
  user_act: z.enum(["new_need", "refine", "confirm", "question", "chitchat"]),
  summary: z.string(),
  anchor: z.string().nullable(),
  origin: z.string().nullable(),
  days: z.number().int().positive().nullable(),
  time_window: z.string().nullable(),
  // 路书的日期（YYYY-MM-DD）。两个都有时，days 由代码按日期计算
  start_date: z.string().nullable().default(null),
  end_date: z.string().nullable().default(null),
  slots: z.object({
    companions: Slot,
    transport: Slot,
    budget: Slot,
    pace: Slot,
    lodging: Slot.default({ value: null, source: null }),
  }),
  hard: z.array(HardConstraint),
  soft: z.array(SoftConstraint),
  // 流程二：按顺序要去的城市
  cities: z.array(z.string()),
  // 在哪些城市里搜索候选地点（城市名，由 LLM 根据 anchor 推断）
  search_regions: z.array(z.string()),
  missing: z.array(MissingInfo).max(2),
  conflicts: z.array(z.string()),
  // 这次用上了灵感池里的哪些旧念头，给用户看，例如"出发地成都：11 月 2 日的露营规划里提过"
  memory_used: z.array(z.string()).default([]),
  // 路书里的"额外需求"，自由文本
  extra: z.string().nullable().default(null),
});

export type HardConstraint = z.infer<typeof HardConstraint>;
export type SoftConstraint = z.infer<typeof SoftConstraint>;
export type Constraints = z.infer<typeof Constraints>;

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type GeoPoint = { name: string; lng: number; lat: number };

// ② 检索计算的结果：每个字段都来自高德，LLM 只能引用，不能修改
export type Check = { label: string; ok: boolean; detail: string };

export type Candidate = {
  rank: number;
  id: string;
  name: string;
  district: string;
  address: string;
  lng: number;
  lat: number;
  photo: string | null;
  rating: number | null;
  driveMinutes: number | null;
  distanceKm: number | null;
  checks: Check[];
  score: number;
  maxScore: number;
  // 可选：图钉自定义的边框颜色和角标（比如单日详情里，待添加的候选地点用橙色、角标"+"）
  color?: string;
  badge?: string;
};

// 流程二：可行性检查。城市间的交通时间来自高德公共交通（含高铁）路线规划
// assumed：用户没说在哪返程时，假设原路返回出发地，地图上画虚线，TT 会说明这是假设
export type RouteLeg = {
  from: string;
  to: string;
  minutes: number | null;
  via: string | null;
  assumed?: boolean;
};

export type RoutePlan = {
  stops: GeoPoint[];
  legs: RouteLeg[];
  // 地图上找不到的地点（例如境外城市），如实告诉用户
  unresolved: string[];
  transferMinutes: number;
  // 按每天 12 小时可活动时间计算；不知道天数时为 null
  availableHours: number | null;
  transferShare: number | null;
  verdict: "relaxed" | "tight" | "overloaded" | "unknown";
};

export type ChatRequest = {
  messages: ChatMessage[];
  constraints: Constraints | null;
  // 用户在界面上删除了某个条件：跳过理解，直接按新条件重新检索
  edit?: string;
  // 用户拖进候选栏的地点，TT 优先围绕它们给建议
  shortlist?: Candidate[];
  // 当前规划
  planId?: number | null;
  // 刚从首页"开始规划"进入：条件已经预填好，直接检索并打招呼
  kickoff?: boolean;
};

export type ChatResponse =
  | {
      ok: true;
      reply: string;
      constraints: Constraints;
      anchor: GeoPoint | null;
      candidates: Candidate[];
      route: RoutePlan | null;
      planId: number | null;
      warnings: string[];
      // 快捷回复：输入框上方的预估发言，点一下直接发送
      suggestions?: string[];
    }
  | { ok: false; error: string };

// 空白路书：用"+ 规划"新建、还没说任何需求时使用
export function blankConstraints(): Constraints {
  const empty = { value: null, source: null };
  return {
    intent: "choose_destination",
    user_act: "new_need",
    summary: "",
    anchor: null,
    origin: null,
    days: null,
    time_window: null,
    start_date: null,
    end_date: null,
    slots: { companions: empty, transport: empty, budget: empty, pace: empty, lodging: empty },
    hard: [],
    soft: [],
    cities: [],
    search_regions: [],
    missing: [],
    conflicts: [],
    memory_used: [],
    extra: null,
  };
}

// 有了开始和结束日期，天数由代码计算，不让模型自己数（前后端都会用到，所以放在这里）
export function withDaysFromDates(c: Constraints): Constraints {
  if (!c.start_date || !c.end_date) return c;
  const days = Math.round((Date.parse(c.end_date) - Date.parse(c.start_date)) / 86_400_000) + 1;
  return days > 0 ? { ...c, days } : c;
}

// 旧版本存下来的规划缺少后来新增的字段（日期、住宿、额外需求），读出来时补上默认值
export function normalizeConstraints(c: Constraints | null): Constraints | null {
  if (!c) return null;
  const blank = blankConstraints();
  return { ...blank, ...c, slots: { ...blank.slots, ...c.slots } };
}

// ---------- 逐日行程（"生成规划"的产出） ----------
// verified 表示这一项的地点和时间来自高德；false 是 TT 的建议（例如建议停留多久），界面上会区分开

export type ItineraryItem = {
  // stay：当天的住宿（固定在一天的最后，不能拖动）
  kind: "transit" | "place" | "free" | "stay";
  title: string;
  start: string | null;
  minutes: number;
  via: string | null;
  placeId: string | null;
  photo: string | null;
  verified: boolean;
  // 地点的坐标：拖动调整顺序后，用来重新计算相邻地点之间的车程
  lng?: number;
  lat?: number;
  // 同城内的自驾段（相邻地点之间、从城市出发 / 回到城市）；城际交通为 false
  local?: boolean;
  // 时间轴上的小点也可以单独标记完成
  done?: boolean;
  // 用户在单日详情里手动改过开始时间：重新排时间时以它为准，不再自动推算
  pinned?: boolean;
  // 手动时间比前一项结束得还早，和前一项重叠
  conflict?: boolean;
  // 同城交通段：交通方式（步行 / 公交地铁 / 打车 / 自驾）、两端坐标、谁定的（TT 按规则选，或用户在地图上改的）
  mode?: LegMode;
  endpoints?: { from: GeoPoint; to: GeoPoint };
  chosenBy?: "tt" | "user";
  distanceM?: number | null;
  // 开放时间（景点本身，或用餐的那家餐厅；placeId 记录是哪个地点的，换了地点就重新查）
  hours?: (OpeningHours & { placeId: string }) | null;
  // 按现在的安排和开放时间对不上：例如"16:30 就关门了，只能待 30 分钟"
  hoursIssue?: string | null;
  // 用餐的餐厅：在前一个地点附近从高德查的（"餐饮服务"大类），可以在对话里让 TT 换一家
  venue?: Venue | null;
};

export type LegMode = "walk" | "transit" | "taxi" | "drive";

export type OpeningHours = {
  text: string;
  // 一天里可以待的时段（分钟，结束可以超过 24:00 表示跨午夜）；null 表示没认出来
  ranges: [number, number][] | null;
  // 不开放的星期几（0 是周日）
  closedDays: number[];
  // 是否有旺季 / 淡季两种时间（取了两者都满足的部分）
  seasonal: boolean;
};


export type Venue = {
  name: string;
  placeId: string;
  photo: string | null;
  lng: number;
  lat: number;
  distanceM: number | null;
  // 离哪个地点近（"离锦里古街约 300 米"）
  near: string | null;
  // TT 选这家的理由（生成行程时由 LLM 从附近的候选里挑），例如"本地老字号川菜"
  why?: string | null;
};

export type DayLoad = "ok" | "tight" | "overloaded";

export type ItineraryDay = {
  index: number;
  date: string | null;
  city: string;
  items: ItineraryItem[];
  transitMinutes: number;
  playMinutes: number;
  load: DayLoad;
  done: boolean;
  // 这一天的活动时间段（默认 09:00–21:00），负荷条的总长度按它算
  window?: { start: string; end: string } | null;
  // 大点右侧的一两句介绍：这一天在哪、主要做什么（TT 写的，不含价格、开放时间等具体数字）
  intro?: string | null;
};

export type Itinerary = {
  title: string;
  banner: string | null;
  days: ItineraryDay[];
  generatedAt: string;
};

// 改某一天时顺带的修改：活动时间段、换住宿（来自"替换"的酒店候选）
export type DayPatch = {
  window?: { start: string; end: string };
  stay?: { id: string; name: string; photo: string | null; lng: number; lat: number; district?: string };
};

// ---------- 旅行中：出发时的基准和路上的记录 ----------
// 点「出发」时把当时的行程存一份（只读），路上的修改仍然改同一份行程，基准只用来对比"计划和实际"。
// 记录按"第几天 + 条目名"对应（和撤销保留完成标记的规则一样），文字和照片都是用户自己的
export type Departure = { at: string; itinerary: Itinerary };

// fromChat：有一部分来自旅行中对话里说的感受（TT 自动记的）
export type TripNote = { text: string; photos: string[]; updatedAt: string; fromChat?: boolean };

// ---------- 旅行后的游记 ----------
// 按天组织：去过的地方（以打了勾的为准）、照片（默认高德的，可以换成自己上传的）、一段文字（TT 根据事实和用户的回答写，可以改）
export type JournalPhoto = { url: string; source: "amap" | "user"; caption: string | null };

export type JournalDay = {
  index: number;
  date: string | null;
  city: string;
  title: string;
  places: string[];
  photos: JournalPhoto[];
  text: string;
};

export type Journal = {
  title: string;
  summary: string;
  days: JournalDay[];
  stats: { days: number; cities: number; places: number; walkKm: number; rideKm: number };
  createdAt: string;
  updatedAt: string;
};
