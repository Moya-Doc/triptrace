import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Candidate, ChatMessage, Constraints, Departure, GeoPoint, Itinerary, Journal, RoutePlan, TripNote } from "./types";

// 本地数据：灵感池（只存不排）和规划。
// 数据文件在 data/triptrace.db，不会被提交进代码仓库。

let db: DatabaseSync | null = null;

function getDb() {
  if (db) return db;
  const dir = path.join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, "triptrace.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS inspiration_cards (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_text    TEXT NOT NULL,
      summary     TEXT NOT NULL,
      places      TEXT NOT NULL,  -- JSON：anchor、search_regions、cities
      activities  TEXT NOT NULL,  -- JSON：硬约束标签
      preferences TEXT NOT NULL,  -- JSON：软约束标签
      status      TEXT NOT NULL DEFAULT '收集中',
      created_at  TEXT NOT NULL
    );
    -- 首页对话的历史总表：每次打开首页、说出第一句话，就是一段新对话
    CREATE TABLE IF NOT EXISTS conversations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      messages    TEXT NOT NULL,   -- JSON
      plan_id     INTEGER,         -- 从这段对话"开始规划"后，指向那个规划
      started_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    -- 行程的修改历史（用于撤销）：每次修改前，把修改前的行程存一份，label 是这次修改做了什么
    CREATE TABLE IF NOT EXISTS itinerary_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id     INTEGER NOT NULL,
      label       TEXT NOT NULL,
      itinerary   TEXT NOT NULL,   -- JSON：修改前的行程
      created_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plans (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT '待开始',  -- 待开始 / 已完成
      state       TEXT NOT NULL,                  -- JSON：对话、条件、候选地点、路线、候选栏
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
  `);
  // 旧版本的卡片表没有 plan_id，补上这一列：卡片记得自己来自哪个规划
  const columns = db.prepare("PRAGMA table_info(inspiration_cards)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "plan_id")) {
    db.exec("ALTER TABLE inspiration_cards ADD COLUMN plan_id INTEGER");
  }
  // 灵感卡片只来自首页对话（2026-11-02 用户决定），记下来自哪段对话
  if (!columns.some((c) => c.name === "conversation_id")) {
    db.exec("ALTER TABLE inspiration_cards ADD COLUMN conversation_id INTEGER");
  }
  // 卡片来源：首页对话（默认），或者旅行后的回顾（"这次哪里喜欢、哪里后悔"）
  if (!columns.some((c) => c.name === "source")) {
    db.exec("ALTER TABLE inspiration_cards ADD COLUMN source TEXT");
  }
  return db;
}

// ---------- 灵感卡片 ----------

export type InspirationCard = {
  id: number;
  rawText: string;
  summary: string;
  activities: string[];
  preferences: string[];
  places: { anchor: string | null; cities: string[] };
  status: string;
  planId: number | null;
  createdAt: string;
  // reflection：旅行回来后的回顾（"哪里喜欢、哪里后悔"），是亲身经历后的偏好
  source: string | null;
};

export function saveInspirationCard(rawText: string, c: Constraints, conversationId: number): number {
  const result = getDb()
    .prepare(
      `INSERT INTO inspiration_cards
         (raw_text, summary, places, activities, preferences, conversation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rawText,
      c.summary,
      JSON.stringify({ anchor: c.anchor, search_regions: c.search_regions, cities: c.cities }),
      JSON.stringify(c.hard.map((h) => h.label)),
      JSON.stringify(c.soft.map((s) => s.label)),
      conversationId,
      new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}

type CardRow = {
  id: number;
  raw_text: string;
  summary: string;
  places: string;
  activities: string;
  preferences: string;
  status: string;
  plan_id: number | null;
  created_at: string;
  source?: string | null;
};

function toCard(r: CardRow): InspirationCard {
  return {
    id: r.id,
    rawText: r.raw_text,
    summary: r.summary,
    activities: JSON.parse(r.activities),
    preferences: JSON.parse(r.preferences),
    places: JSON.parse(r.places),
    status: r.status,
    planId: r.plan_id,
    createdAt: r.created_at,
    source: r.source ?? null,
  };
}

// 长期记忆：最近的灵感卡片，新的在前。
// 读来自首页对话的卡片（conversation_id 不为空）和旅行后的回顾；旧版本在规划内对话里存下的卡片属于那个规划的临时决定，不算长期记忆
export function listInspirationCards(limit = 50): InspirationCard[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM inspiration_cards
       WHERE status != '已剔除' AND (conversation_id IS NOT NULL OR source = 'reflection')
       ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as CardRow[];
  return rows.map(toCard);
}

export function countInspirationCards(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM inspiration_cards").get() as { n: number };
  return row.n;
}

// ---------- 规划 ----------

export type PlanStatus = "待开始" | "已完成";

export type PlanState = {
  messages: ChatMessage[];
  constraints: Constraints | null;
  anchor: GeoPoint | null;
  candidates: Candidate[];
  route: RoutePlan | null;
  shortlist: Candidate[];
  // 点了"生成规划"之后才有
  itinerary?: Itinerary | null;
  // 旅行中书签的对话（和规划对话分开）
  liveMessages?: ChatMessage[];
  // TT 提议、等用户确认的修改（规划对话 / 旅行中对话各一份）；用户说"好，改吧"时直接执行
  pendingOps?: unknown[];
  livePendingOps?: unknown[];
  // 点「出发」时存下的行程（只读的基准）；路上写的记录，键是"第几天|条目名"
  departure?: Departure | null;
  notes?: Record<string, TripNote>;
  // 旅行中说的感受，但说的地方还排在"现在"之后：先不记，等用户确认已经到了（按现在重排时再记）
  livePendingNotes?: unknown[];
  // 旅行后书签：TT 的提问和用户的回答，以及生成的游记
  afterMessages?: ChatMessage[];
  afterQuestions?: string[];
  journal?: Journal | null;
};

export type PlanSummary = {
  id: number;
  title: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  // 首页拍立得的"照片"：候选栏或推荐结果里第一张真实照片；路线规划则显示途经城市
  cover: { photo: string | null; stops: string[] };
};

export function createPlan(title: string, state: PlanState): number {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare("INSERT INTO plans (title, state, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(title, JSON.stringify(state), now, now);
  return Number(result.lastInsertRowid);
}

export function savePlan(id: number, patch: { title?: string; state?: Partial<PlanState> }) {
  const plan = getPlan(id);
  if (!plan) return;
  const state = { ...plan.state, ...patch.state };
  getDb()
    .prepare("UPDATE plans SET title = ?, state = ?, updated_at = ? WHERE id = ?")
    .run(patch.title ?? plan.title, JSON.stringify(state), new Date().toISOString(), id);
}

export function getPlan(id: number): (PlanSummary & { state: PlanState }) | null {
  const row = getDb().prepare("SELECT * FROM plans WHERE id = ?").get(id) as
    | { id: number; title: string; status: PlanStatus; state: string; created_at: string; updated_at: string }
    | undefined;
  if (!row) return null;
  const state: PlanState = JSON.parse(row.state);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cover: coverOf(state),
    state,
  };
}

function coverOf(state: PlanState): PlanSummary["cover"] {
  const photo = [...(state.shortlist ?? []), ...(state.candidates ?? [])].find((c) => c.photo)?.photo ?? null;
  return { photo, stops: state.route?.stops.map((s) => s.name) ?? [] };
}

// 首页的规划列表，按创建时间排列，新的在前
export function listPlans(): PlanSummary[] {
  const rows = getDb().prepare("SELECT id FROM plans ORDER BY created_at DESC").all() as { id: number }[];
  return rows.map((r) => {
    const p = getPlan(r.id)!;
    return { id: p.id, title: p.title, status: p.status, createdAt: p.createdAt, updatedAt: p.updatedAt, cover: p.cover };
  });
}

// 规划标记为已完成时，它带来的灵感卡片也变成"已实现"（念头的生命周期）；改回待开始则恢复
export function setPlanStatus(id: number, status: PlanStatus) {
  const d = getDb();
  d.prepare("UPDATE plans SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    new Date().toISOString(),
    id,
  );
  d.prepare("UPDATE inspiration_cards SET status = ? WHERE plan_id = ? AND status != '已剔除'").run(
    status === "已完成" ? "已实现" : "收集中",
    id,
  );
}

// 从首页对话开始规划后，这段对话带来的灵感卡片也归到这个规划下（规划完成时一起变成"已实现"）
export function linkConversationToPlan(conversationId: number, planId: number) {
  const d = getDb();
  d.prepare("UPDATE conversations SET plan_id = ? WHERE id = ?").run(planId, conversationId);
  d.prepare("UPDATE inspiration_cards SET plan_id = ? WHERE conversation_id = ?").run(planId, conversationId);
}

// ---------- 首页对话历史 ----------

export type ConversationSummary = {
  id: number;
  preview: string;
  messageCount: number;
  planId: number | null;
  startedAt: string;
  updatedAt: string;
};

export function saveConversation(id: number | null, messages: ChatMessage[]): number {
  const d = getDb();
  const now = new Date().toISOString();
  if (id !== null) {
    d.prepare("UPDATE conversations SET messages = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(messages),
      now,
      id,
    );
    return id;
  }
  const result = d
    .prepare("INSERT INTO conversations (messages, started_at, updated_at) VALUES (?, ?, ?)")
    .run(JSON.stringify(messages), now, now);
  return Number(result.lastInsertRowid);
}

export function listConversations(): (ConversationSummary & { messages: ChatMessage[] })[] {
  const rows = getDb().prepare("SELECT * FROM conversations ORDER BY updated_at DESC").all() as {
    id: number;
    messages: string;
    plan_id: number | null;
    started_at: string;
    updated_at: string;
  }[];
  return rows.map((r) => {
    const messages: ChatMessage[] = JSON.parse(r.messages);
    return {
      id: r.id,
      preview: messages.find((m) => m.role === "user")?.content ?? "",
      messageCount: messages.length,
      planId: r.plan_id,
      startedAt: r.started_at,
      updatedAt: r.updated_at,
      messages,
    };
  });
}

// ---------- 行程的撤销 ----------
// 拖动、删除、替换、改时间、换交通方式、TT 在对话里改的、重新生成，都会先把修改前的行程存进历史。
// 标记完成不算修改（撤销时保留当前的完成状态）。每个规划最多保留最近 15 步

const HISTORY_LIMIT = 15;

export type UndoState = { count: number; last: string | null };

// 保存新的行程。label 为 null 表示这是系统自己的整理（比如把旧格式的行程补全），不进历史
export function saveItinerary(planId: number, next: Itinerary, label: string | null, extra: Partial<PlanState> = {}): UndoState {
  const plan = getPlan(planId);
  if (!plan) return { count: 0, last: null };
  const db = getDb();
  if (label && plan.state.itinerary) {
    db.prepare("INSERT INTO itinerary_history (plan_id, label, itinerary, created_at) VALUES (?, ?, ?, ?)").run(
      planId,
      label.slice(0, 80),
      JSON.stringify(plan.state.itinerary),
      new Date().toISOString(),
    );
    db.prepare(
      "DELETE FROM itinerary_history WHERE plan_id = ? AND id NOT IN (SELECT id FROM itinerary_history WHERE plan_id = ? ORDER BY id DESC LIMIT ?)",
    ).run(planId, planId, HISTORY_LIMIT);
  }
  savePlan(planId, { state: { ...extra, itinerary: next } });
  return undoState(planId);
}

export function undoState(planId: number): UndoState {
  const rows = getDb()
    .prepare("SELECT label FROM itinerary_history WHERE plan_id = ? ORDER BY id DESC")
    .all(planId) as { label: string }[];
  return { count: rows.length, last: rows[0]?.label ?? null };
}

// 撤销最近一步：恢复修改前的行程，但保留现在的"已完成"标记（按天和条目名对应）
export function undoItinerary(planId: number): { itinerary: Itinerary; label: string; undo: UndoState } | null {
  const plan = getPlan(planId);
  const row = getDb()
    .prepare("SELECT id, label, itinerary FROM itinerary_history WHERE plan_id = ? ORDER BY id DESC LIMIT 1")
    .get(planId) as { id: number; label: string; itinerary: string } | undefined;
  if (!plan || !row) return null;
  const restored: Itinerary = JSON.parse(row.itinerary);
  const current = plan.state.itinerary;
  const done = new Set(
    (current?.days ?? []).flatMap((d) => d.items.filter((x) => x.done).map((x) => `${d.index}|${x.title}`)),
  );
  const doneDays = new Set((current?.days ?? []).filter((d) => d.done).map((d) => d.index));
  const itinerary = {
    ...restored,
    days: restored.days.map((d) => ({
      ...d,
      done: doneDays.has(d.index),
      items: d.items.map((x) => ({ ...x, done: done.has(`${d.index}|${x.title}`) })),
    })),
  };
  getDb().prepare("DELETE FROM itinerary_history WHERE id = ?").run(row.id);
  savePlan(planId, { state: { itinerary } });
  return { itinerary, label: row.label, undo: undoState(planId) };
}

// 旅行后的回顾写回灵感池："这次哪里喜欢、哪里后悔"。下次规划时，理解模块会读到它（例如"上次成都之行觉得太赶"）
export function saveReflection(planId: number, rawText: string, summary: string, places: string[]): number {
  const result = getDb()
    .prepare(
      `INSERT INTO inspiration_cards
         (raw_text, summary, places, activities, preferences, plan_id, source, created_at)
       VALUES (?, ?, ?, '[]', '[]', ?, 'reflection', ?)`,
    )
    .run(rawText, summary, JSON.stringify({ anchor: null, search_regions: [], cities: places }), planId, new Date().toISOString());
  return Number(result.lastInsertRowid);
}
