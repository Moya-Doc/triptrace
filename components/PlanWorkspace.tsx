"use client";

import { UndoOutlined } from "@ant-design/icons";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RichText from "@/components/RichText";
import ErrorNote from "@/components/ErrorNote";
import CandidateCard from "@/components/CandidateCard";
import DayDetail from "@/components/DayDetail";
import AfterPanel from "@/components/AfterPanel";
import JournalView from "@/components/JournalView";
import LivePanel from "@/components/LivePanel";
import TripView from "@/components/TripView";
import KeepAlive from "@/components/KeepAlive";
import PaneSwitch, { slide, useIsMobile } from "@/components/PaneSwitch";
import ItineraryView from "@/components/ItineraryView";
import RoadbookView, {
  missingRequired,
  type LocateState,
} from "@/components/RoadbookView";
import MapView from "@/components/MapView";
import ShortlistTray, { TRAY_HEIGHT } from "@/components/ShortlistTray";
import type { PlanState, PlanStatus } from "@/lib/db";
import {
  blankConstraints,
  normalizeConstraints,
  withDaysFromDates,
  type Candidate,
  type ChatMessage,
  type ChatResponse,
  type Constraints,
  type GeoPoint,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
  type Journal,
  type DayPatch,
  type Departure,
  type TripNote,
  type LegMode,
  type RoutePlan,
} from "@/lib/types";

// 规划工作台：左边对话，右边路书清单 / 地图。每次对话后服务端自动存档，首页可以重新打开。

type Status = { llm: boolean; amapWebService: boolean; amapJs: boolean };
type Layout = "roadbook" | "split" | "map";

type Props = {
  planId: number | null;
  title: string | null;
  status: PlanStatus;
  initial: PlanState | null;
  // 从首页对话"开始规划"进入：路书已预填，打开后让 TT 先检索并说明
  kickoff: boolean;
  // 回到首页时带上规划 id：如果是这次新建的，首页会播放"贴上去"的动画
  onHome: (planId: number | null) => void;
};

export default function PlanWorkspace(props: Props) {
  const { initial, kickoff, onHome } = props;
  const planId = props.planId;
  const [planStatus, setPlanStatus] = useState<PlanStatus>(props.status);
  const [messages, setMessages] = useState<ChatMessage[]>(
    initial?.messages ?? [],
  );
  const [constraints, setConstraints] = useState<Constraints | null>(
    normalizeConstraints(initial?.constraints ?? null),
  );
  const [anchor, setAnchor] = useState<GeoPoint | null>(
    initial?.anchor ?? null,
  );
  const [candidates, setCandidates] = useState<Candidate[]>(
    initial?.candidates ?? [],
  );
  const [route, setRoute] = useState<RoutePlan | null>(initial?.route ?? null);
  const [shortlist, setShortlist] = useState<Candidate[]>(
    initial?.shortlist ?? [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // 进入规划时先显示路书清单，地图在背后加载，用户切过去时已经准备好了
  const [layout, setLayout] = useState<Layout>("split");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [input, setInput] = useState("");
  // 撤销：还能撤销几步、最近一步是什么；toast 是刚做完一次修改后，在右下角停留几秒的提示
  const [undo, setUndo] = useState<{ count: number; last: string | null }>({ count: 0, last: null });
  const [toast, setToast] = useState<{ label: string; key: number } | null>(null);
  // 输入框上方的快捷回复：TT 预估用户最可能说的下一句，点一下直接发送
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [itinerary, setItinerary] = useState<Itinerary | null>(
    initial?.itinerary ?? null,
  );
  const [generating, setGenerating] = useState(false);
  // 单日详情：点了时间轴上的景点后打开
  // 对话栏的三个书签：规划 / 旅行中的记录 / 旅行后的总结
  const [tab, setTab] = useState<ChatTab>("plan");
  // 旅行后写好的游记：在"旅行后"书签里，右边显示游记
  const [journal, setJournal] = useState<Journal | null>(initial?.journal ?? null);
  // 旅行中：点「出发」时存下的计划（只用来对比）、路上写的记录、左边"今天"是第几天和刚到哪
  const [departure, setDeparture] = useState<Departure | null>(initial?.departure ?? null);
  const [notes, setNotes] = useState<Record<string, TripNote>>(initial?.notes ?? {});
  const [live, setLive] = useState<{ day: number; at: string } | null>(null);
  // 旅行中 TT 改了行程：右边的时间轴滚到"现在在这"
  const [focusNow, setFocusNow] = useState(0);
  const onLive = useCallback((v: { day: number; at: string } | null) => setLive(v), []);
  // 手机上一次只看一边（见 PaneSwitch），每个书签各记各的。打开时先看最要紧的那边：
  // 有行程就看行程；旅行中还没出发，看"出发"那一页；其余看对话
  const [panes, setPanes] = useState<Record<ChatTab, "chat" | "side">>({
    plan: initial?.itinerary ? "side" : "chat",
    during: initial?.itinerary && !initial?.departure ? "side" : "chat",
    after: "chat",
  });
  const pane = panes[tab];
  const isMobile = useIsMobile();
  // 手机上放不下"各占一半"，只看路书或地图
  const shownLayout = isMobile && layout === "split" ? "roadbook" : layout;
  // 在对话这边时，行程、记录或游记变了：不自动跳过去，只在开关上标个小红点
  const stamp = useMemo(
    () => JSON.stringify([itinerary?.days ?? null, notes, journal?.createdAt ?? null]),
    [itinerary, notes, journal],
  );
  const [seen, setSeen] = useState(stamp);
  function showPane(p: "chat" | "side") {
    setPanes((x) => ({ ...x, [tab]: p }));
    setSeen(stamp);
  }
  // 从路书、候选栏让 TT 回答：回复在对话里，切过去
  function ask(text: string) {
    showPane("chat");
    send(text);
  }
  const [detail, setDetail] = useState<{
    day: number;
    title: string | null;
  } | null>(null);
  // 单日详情的外层：挂载时从右往左滑进来，关闭时先从左往右滑出去再卸载
  const detailRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 上一次请求失败时，"重试"按钮重新执行它
  const retryRef = useRef<(() => void) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 拖动、撤销、出发这些失败时不给"重试"：留着的话，点了会重发上一句对话
  function failOnce(message: string) {
    retryRef.current = null;
    setError(message);
  }
  const [status, setStatus] = useState<Status | null>(null);
  const [locate, setLocate] = useState<LocateState>("idle");
  const bottomRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // 打开规划时：出发地为空就先定位当前城市；如果是从首页"开始规划"进来的，再让 TT 根据预填的路书开口。
  // 先定位再开口，是为了让 TT 的第一条回复就用上出发地（开发模式下 effect 会执行两次，用 ref 防重复）
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      let current = constraints;
      if (!current?.origin) {
        const city = await locateCity();
        if (city) {
          current = { ...(current ?? blankConstraints()), origin: city };
          setConstraints(current);
          if (planId !== null) patchPlan(planId, { constraints: current });
        }
      }
      if (kickoff && current) call([], current, undefined, true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时执行一次
  }, []);

  async function locateCity(): Promise<string | null> {
    setLocate("locating");
    const city = await currentCity();
    setLocate(city ? "idle" : "failed");
    return city;
  }

  async function relocate() {
    const city = await locateCity();
    if (city) send(`出发地改为${city}`);
  }

  async function call(
    next: ChatMessage[],
    current: Constraints | null,
    edit?: string,
    isKickoff = false,
    regenerate = false,
  ) {
    retryRef.current = () => call(next, current, edit, isKickoff, regenerate);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next,
          constraints: current,
          edit,
          kickoff: isKickoff,
          shortlist,
          planId,
        }),
      });
      const data: ChatResponse = await res.json();
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setMessages([...next, { role: "assistant", content: data.reply }]);
      setSuggestions(data.suggestions ?? []);
      setConstraints(normalizeConstraints(data.constraints));
      setAnchor(data.anchor);
      setCandidates(data.candidates);
      setRoute(data.route);
      setSelectedId(null);
      setWarnings(data.warnings);
      // 整体条件变了（换目的地、改日期等）：TT 回复之后，按新的路书重新生成行程
      if (regenerate) await generate([...next, { role: "assistant", content: data.reply }]);
    } catch {
      setError("连不上服务器，请确认开发服务器还在运行");
    } finally {
      setLoading(false);
    }
  }

  function send(text: string) {
    const content = text.trim();
    if (!content || loading) return;
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setSuggestions([]);
    if (itinerary && planId !== null) command(next);
    else call(next, constraints);
  }

  // 生成行程之后，对话直接操控行程：服务端先判断这句话是不是在调整某一天的安排，是就直接改；
  // 提问和闲聊根据当前行程回答；改目的地、日期这类整体变化，走原来的对话流程，再重新生成行程
  async function command(next: ChatMessage[]) {
    retryRef.current = () => command(next);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/plans/${planId}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error);
        setLoading(false);
        return;
      }
      if (data.kind !== "replan") {
        if (data.itinerary) setItinerary(data.itinerary);
        applyUndo(data.undo);
        setSuggestions(data.suggestions ?? []);
        setMessages([...next, { role: "assistant", content: data.reply }]);
        setLoading(false);
        return;
      }
      await call(next, constraints, undefined, false, data.kind === "replan");
    } catch {
      setError("连不上服务器，请确认开发服务器还在运行");
      setLoading(false);
    }
  }

  // 在路书上删掉一个偏好后，按新条件重新检索（US2）
  function removeCondition(kind: "hard" | "soft", i: number) {
    if (!constraints || loading) return;
    const list = constraints[kind];
    const label = list[i].label;
    const updated = {
      ...constraints,
      [kind]: list.filter((_, j) => j !== i),
    } as Constraints;
    setConstraints(updated);
    call(messages, updated, `删除了「${label}」`);
  }

  // 改日期：天数由代码计算。已经有路线时要重算"赶不赶"，所以交给 TT；否则直接保存
  function changeDates(start: string | null, end: string | null) {
    const updated = withDaysFromDates({
      ...(constraints ?? blankConstraints()),
      start_date: start,
      end_date: end,
    });
    setConstraints(updated);
    if (route && start && end && !loading)
      call(messages, updated, `日期改为 ${start} 至 ${end}`);
    else if (planId !== null) patchPlan(planId, { constraints: updated });
  }

  // 交通、住宿、同行人、预算：用户自己填的，直接保存
  function changeSlot(
    key: "transport" | "lodging" | "companions" | "budget",
    value: string | null,
  ) {
    const base = constraints ?? blankConstraints();
    const updated = {
      ...base,
      slots: { ...base.slots, [key]: { value, source: value ? "user" : null } },
    } as Constraints;
    setConstraints(updated);
    if (planId !== null) patchPlan(planId, { constraints: updated });
  }

  // 候选栏的变化也要存进规划
  function updateShortlist(next: Candidate[]) {
    setShortlist(next);
    if (planId !== null) patchPlan(planId, { shortlist: next });
  }

  function addToShortlist(id: string) {
    const c = candidates.find((x) => x.id === id);
    if (c && !shortlist.some((x) => x.id === id))
      updateShortlist([...shortlist, c]);
  }

  // 生成规划：把路书和地图结果交给服务端，生成逐日行程
  async function generate(base: ChatMessage[] = messages) {
    retryRef.current = () => generate(base);
    if (planId === null || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/plans/${planId}/itinerary`, {
        method: "POST",
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setItinerary(data.itinerary);
      setDetail(null);
      setMessages([...base, data.message]);
      applyUndo(data.undo);
    } catch {
      setError("连不上服务器，请确认开发服务器还在运行");
    } finally {
      setGenerating(false);
    }
  }

  // 拖动调整某一天的活动顺序：服务端按新顺序重新查车程、排时间、判断负荷
  // 服务端每次改完行程都会返回撤销状态；多了一步就弹出"刚才做了什么 · 撤销"
  function applyUndo(next: { count: number; last: string | null } | undefined) {
    if (!next) return;
    if (next.count > 0 && next.last && (next.count > undo.count || next.last !== undo.last))
      setToast({ label: next.last, key: Date.now() });
    setUndo(next);
  }

  async function undoLast() {
    if (planId === null || !undo.count) return;
    setToast(null);
    try {
      const res = await fetch(`/api/plans/${planId}/itinerary/undo`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        failOnce(data.error);
        return;
      }
      setItinerary(data.itinerary);
      setMessages((m) => [...m, data.message]);
      setUndo(data.undo);
    } catch {
      failOnce("连不上服务器，请确认开发服务器还在运行");
    }
  }

  // 打开规划时读一次撤销状态（之前的修改也能撤销）
  useEffect(() => {
    if (planId === null) return;
    fetch(`/api/plans/${planId}/itinerary/undo`)
      .then((r) => r.json())
      .then((d) => d.ok && setUndo(d.undo))
      .catch(() => {});
  }, [planId]);

  // 提示停留 8 秒
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(timer);
  }, [toast]);

  // patch：顺带改这一天的活动时间段，或者换住宿
  async function reorderDay(
    dayIndex: number,
    order: ItineraryItem[],
    legs?: Record<string, LegMode>,
    label?: string | null,
    patch?: DayPatch,
  ) {
    if (planId === null) return;
    // 删除先在界面上立刻生效，新的时间等服务端算好（通常一秒左右）再更新
    if (itinerary) {
      const kept = new Set(order.map((x) => `${x.kind}:${x.title}`));
      setItinerary({
        ...itinerary,
        days: itinerary.days.map((d) =>
          d.index === dayIndex
            ? { ...d, items: d.items.filter((x) => (x.kind !== "place" && x.kind !== "free") || kept.has(`${x.kind}:${x.title}`)) }
            : d,
        ),
      });
    }
    try {
      const res = await fetch(`/api/plans/${planId}/itinerary`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dayIndex, order, legs, label, ...patch }),
      });
      const data = await res.json();
      if (!data.ok) failOnce(data.error);
      else {
        setItinerary(data.itinerary);
        applyUndo(data.undo);
      }
    } catch {
      failOnce("连不上服务器，请确认开发服务器还在运行");
    }
  }

  // 时间轴上点一下小点：这一项标记为完成 / 未完成
  function toggleItem(dayIndex: number, itemIndex: number) {
    if (!itinerary || planId === null) return;
    const next = {
      ...itinerary,
      days: itinerary.days.map((d) =>
        d.index === dayIndex
          ? withDayDone({
              ...d,
              items: d.items.map((x, i) =>
                i === itemIndex ? { ...x, done: !x.done } : x,
              ),
            })
          : d,
      ),
    };
    setItinerary(next);
    patchPlan(planId, { itinerary: next });
  }

  function openDetail(day: number, title: string) {
    setDetail({ day, title });
  }

  function slideIn(el: HTMLDivElement | null) {
    detailRef.current = el;
    if (!el || el.dataset.entered) return;
    el.dataset.entered = "1";
    el.animate([{ translate: "100% 0" }, { translate: "0 0" }], {
      duration: 300,
      easing: "ease-out",
    });
  }

  function closeDetail() {
    detailRef.current?.animate([{ translate: "0 0" }, { translate: "100% 0" }], {
      duration: 300,
      easing: "ease-in",
      fill: "forwards",
    });
    setTimeout(() => setDetail(null), 300);
  }

  // 时间轴上点一下这一天的大点：这一天的所有条目一起标记为完成 / 未完成（相当于全选）
  function toggleDay(index: number) {
    if (!itinerary || planId === null) return;
    const next = {
      ...itinerary,
      days: itinerary.days.map((d) =>
        d.index === index
          ? { ...d, done: !d.done, items: d.items.map((x) => ({ ...x, done: !d.done })) }
          : d,
      ),
    };
    setItinerary(next);
    patchPlan(planId, { itinerary: next });
  }

  function toggleStatus() {
    if (planId === null) return;
    const next: PlanStatus = planStatus === "已完成" ? "待开始" : "已完成";
    setPlanStatus(next);
    patchPlan(planId, { status: next });
  }

  // 出发：存下现在的行程作为对比的基准
  async function depart() {
    if (planId === null) return;
    try {
      const res = await fetch(`/api/plans/${planId}/depart`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) failOnce(data.error);
      else setDeparture(data.departure);
    } catch {
      failOnce("连不上服务器，请确认开发服务器还在运行");
    }
  }

  async function saveNote(key: string, note: { text: string; photos: string[] }) {
    const res = await fetch(`/api/plans/${planId}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, ...note }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    setNotes(data.notes);
  }

  // 详情卡片既可能来自地图图钉，也可能来自候选栏里更早的地点
  const selected =
    candidates.find((c) => c.id === selectedId) ??
    shortlist.find((c) => c.id === selectedId) ??
    null;
  // 右侧显示哪一页：旅行中 → 记录时间轴；旅行后且有游记 → 游记；其余 → 规划的时间轴
  const right = tab === "during" ? "trip" : tab === "after" && journal ? "journal" : "plan";
  const sideLabel = right === "trip" ? "记录" : right === "journal" ? "游记" : itinerary ? "行程" : "路书";
  const missingKeys = status
    ? [
        !status.llm && "大模型 Key",
        !status.amapWebService && "高德 Web 服务 Key",
        !status.amapJs && "高德 JS API Key",
      ].filter(Boolean)
    : [];

  return (
    <main className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-clip md:grid-cols-[420px_minmax(0,1fr)]">
      {/* 标题和书签：手机上两边共用，切到哪一边都在 */}
      <div className="col-start-1 row-start-1 border-gray-200 bg-[#fbfbfa] md:border-r">
        <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <button
            onClick={() => onHome(planId)}
            className="text-sm text-gray-500 hover:text-gray-900"
          >
            ← 首页
          </button>
          <div className="min-w-0 flex-1 px-3 text-center">
            <h1 className="truncate text-sm font-semibold">
              {props.title ??
                messages.find((m) => m.role === "user")?.content ??
                "新的规划"}
            </h1>
          </div>
          {planId !== null ? (
            <StatusButton status={planStatus} onToggle={toggleStatus} />
          ) : (
            <span className="w-14" />
          )}
        </header>

        <nav className="flex items-center gap-1 border-b border-gray-200 px-3">
          {CHAT_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                if (pane === "side") setSeen(stamp);
                setTab(t.key);
              }}
              className={`-mb-px border-b-2 px-2 py-2 text-sm md:px-3 ${
                tab === t.key
                  ? "border-teal-700 font-semibold text-gray-900"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {t.label}
            </button>
          ))}
          <div className="ml-auto">
            <PaneSwitch
              value={pane}
              onChange={showPane}
              options={[
                { key: "chat", label: "对话" },
                { key: "side", label: sideLabel, dot: pane === "chat" && stamp !== seen },
              ]}
            />
          </div>
        </nav>
      </div>

      {/* 三个书签的内容一直挂载着，切换时只是藏起来：滚动位置、正在等的回复都不会丢（见 KeepAlive） */}
      <section
        inert={isMobile && pane !== "chat"}
        className={`relative col-start-1 row-start-2 min-h-0 border-gray-200 bg-[#fbfbfa] md:border-r ${slide("left", pane === "chat")}`}
      >
          <KeepAlive show={tab === "during"} className="absolute inset-0 flex flex-col">
            {itinerary && planId !== null ? (
              <LivePanel
                planId={planId}
                itinerary={itinerary}
                initialMessages={initial?.liveMessages ?? []}
                onItinerary={setItinerary}
                onUndo={applyUndo}
                onChanged={() => setFocusNow((n) => n + 1)}
                departed={Boolean(departure)}
                baseline={departure?.itinerary ?? null}
                onLive={onLive}
                onNotes={setNotes}
              />
            ) : (
              <TabPlaceholder tab="during" />
            )}
          </KeepAlive>
          <KeepAlive show={tab === "after"} className="absolute inset-0 flex flex-col">
            {planId !== null ? (
              <AfterPanel
                planId={planId}
                hasItinerary={Boolean(itinerary)}
                initialMessages={initial?.afterMessages ?? []}
                initialQuestions={initial?.afterQuestions?.length ?? 0}
                onJournal={setJournal}
              />
            ) : (
              <TabPlaceholder tab="after" />
            )}
          </KeepAlive>
          <KeepAlive show={tab === "plan"} className="absolute inset-0 flex flex-col">
        {missingKeys.length > 0 && (
          <div className="mx-4 mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
            还没配置：{missingKeys.join("、")}。在 <code>.env.local</code>{" "}
            填好后重启开发服务器。
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {messages.length === 0 && !loading && (
            <p className="text-sm leading-6 text-gray-500">
              说说这次想去哪、想做什么，或者直接在右边的路书里填。
            </p>
          )}

          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-teal-700 px-3 py-2 text-sm leading-6 text-white">
                  {m.content}
                </div>
              </div>
            ) : (
              // TT 的话不加气泡，像正文一样排开，读起来更轻松
              <div key={i} className="text-sm leading-7 text-gray-800">
                <RichText text={m.content} />
              </div>
            ),
          )}

          {loading && (
            <div className="text-sm text-gray-400">
              正在理解你的想法，并在地图上查找和核对，大约需要 20 秒…
            </div>
          )}
          {/* 生成行程要挑地点和餐厅、查每段路线和开放时间，实测约 1 分钟：说清楚在做什么，免得用户以为卡住了 */}
          {generating && (
            <div className="text-sm text-gray-400">
              正在生成逐日行程：挑选地点和餐厅，向高德查每一段路线和开放时间，大约需要 1 分钟…
            </div>
          )}
          {error && (
            <ErrorNote message={error} onRetry={retryRef.current && !loading && !generating ? () => retryRef.current?.() : undefined} />
          )}
          {warnings.map((w) => (
            <div key={w} className="text-xs text-amber-700">
              ⚠️ {w}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-gray-200 p-3">
          {suggestions.length > 0 && !loading && (
            <div className="mb-2 flex flex-wrap gap-2">
              {suggestions.map((t) => (
                <button
                  key={t}
                  onClick={() => send(t)}
                  className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs text-teal-800 hover:border-teal-500"
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-end gap-2"
          >
            {/* 多行输入框：回车发送，Shift + 回车换行（输入法选词时的回车不算） */}
            <textarea
              ref={inputRef}
              value={input}
              rows={3}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder={
                itinerary
                  ? "直接说怎么改，比如：第二天武侯祠改到 10 点到 14 点"
                  : constraints
                    ? "补充或修改，比如：不想开那么久的车"
                    : "说说你的想法…"
              }
              className="flex-1 resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-teal-600"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="rounded-lg bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-40"
            >
              发送
            </button>
          </form>
        </div>
          </KeepAlive>
      </section>

      <section
        inert={isMobile && pane !== "side"}
        className={`relative col-start-1 row-start-2 min-h-0 overflow-hidden md:col-start-2 md:row-span-2 md:row-start-1 ${slide("right", pane === "side")}`}
      >
        {itinerary ? (
          // 生成行程之后，右侧只保留行程页；想改什么，直接在左侧告诉 TT。
          // 三个书签各有一张右侧页面（规划的时间轴 / 旅行中的记录 / 游记），都一直挂载着，切回来时还停在原来滚到的位置
          <div className="group/right absolute inset-0">
            <KeepAlive show={right === "plan"} className="absolute inset-0">
            {/* 单日详情盖在时间轴上面：退出详情后，时间轴还停在原来滚到的位置 */}
            <ItineraryView
              itinerary={itinerary}
              onToggleDay={toggleDay}
              onToggleItem={toggleItem}
              onReorder={reorderDay}
              onOpenItem={openDetail}
              onChangeWindow={(dayIndex, start, end) => {
                const day = itinerary.days.find((d) => d.index === dayIndex);
                if (!day) return;
                reorderDay(
                  dayIndex,
                  day.items.filter((x) => x.kind === "place" || x.kind === "free"),
                  undefined,
                  `第 ${dayIndex + 1} 天的活动时间改为 ${start}–${end}`,
                  { window: { start, end } },
                );
              }}
            />
            </KeepAlive>
            {planId !== null && (
              <KeepAlive show={right === "trip"} className="absolute inset-0">
                <TripView
                  planId={planId}
                  itinerary={itinerary}
                  departure={departure}
                  notes={notes}
                  live={live}
                  focusNow={focusNow}
                  onDepart={depart}
                  onSaveNote={saveNote}
                  onOpenItem={openDetail}
                  onToggleItem={toggleItem}
                />
              </KeepAlive>
            )}
            {journal && planId !== null && (
              <KeepAlive show={right === "journal"} className="absolute inset-0">
                <JournalView key={journal.createdAt} planId={planId} journal={journal} onChange={setJournal} />
              </KeepAlive>
            )}
            {detail && planId !== null && right !== "journal" && (
              <div ref={slideIn} className="absolute inset-0 z-20">
                <DayDetail
                  key={detail.day}
                  planId={planId}
                  itinerary={itinerary}
                  dayIndex={detail.day}
                  selectedTitle={detail.title}
                  onBack={closeDetail}
                  onChangeDay={(day) => setDetail({ day, title: null })}
                  onSave={reorderDay}
                />
              </div>
            )}
            {/* 撤销：右上角一直在（有可撤销的修改时）；刚改完时右下角另有一条提示 */}
            {undo.count > 0 && right !== "journal" && (
              <button
                onClick={undoLast}
                title={undo.last ? `撤销：${undo.last}` : "撤销"}
                className="absolute right-4 top-4 z-30 flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1.5 text-xs text-gray-700 shadow-md hover:text-gray-900 group-has-[[data-full-panel]]/right:hidden"
              >
                <UndoOutlined /> 撤销
              </button>
            )}
            {toast && right !== "journal" && (
              <div
                key={toast.key}
                className="absolute bottom-16 left-1/2 z-30 flex max-w-[90%] -translate-x-1/2 md:bottom-6 items-center gap-3 rounded-full bg-gray-900 px-4 py-2 text-sm text-white shadow-lg"
              >
                <span className="truncate">{toast.label}</span>
                <button onClick={undoLast} className="shrink-0 font-semibold text-teal-300 hover:text-teal-200">
                  撤销
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* 路书和地图并排；胶囊切换三档：全屏路书 / 各占一半 / 全屏地图。
                两边一直挂载着，只改宽度：地图不会被销毁重建 */}
            <div className="flex h-full">
              <div
                style={{
                  width:
                    shownLayout === "map"
                      ? "0%"
                      : shownLayout === "split"
                        ? "50%"
                        : "100%",
                }}
                className={`relative h-full shrink-0 overflow-hidden transition-[width] duration-300 ${
                  shownLayout === "split" ? "border-r-2 border-gray-200" : ""
                }`}
              >
                <RoadbookView
                  constraints={constraints ?? blankConstraints()}
                  locate={locate}
                  busy={loading}
                  onAskTT={ask}
                  onDates={changeDates}
                  onSlot={changeSlot}
                  onRemove={removeCondition}
                  onLocate={relocate}
                  hasItinerary={false}
                  generating={generating}
                  onGenerate={() => generate()}
                />
              </div>
              <div className="relative h-full min-w-0 flex-1 overflow-hidden">
                <MapView
                  anchor={anchor}
                  candidates={candidates}
                  route={route}
                  selectedId={selectedId}
                  shortlistIds={shortlist.map((c) => c.id)}
                  onSelect={setSelectedId}
                  onMapClick={() => setSelectedId(null)}
                  dropZoneHeight={TRAY_HEIGHT}
                  onDragOverDropZone={setDragOver}
                  onDropToShortlist={addToShortlist}
                />
                {selected && (
                  <div
                    className="absolute inset-x-0 z-20"
                    style={{ bottom: TRAY_HEIGHT }}
                  >
                    <CandidateCard
                      c={selected}
                      shortlisted={shortlist.some((x) => x.id === selected.id)}
                      onToggleShortlist={() =>
                        shortlist.some((x) => x.id === selected.id)
                          ? updateShortlist(
                              shortlist.filter((x) => x.id !== selected.id),
                            )
                          : addToShortlist(selected.id)
                      }
                      onClose={() => setSelectedId(null)}
                    />
                  </div>
                )}
                {(candidates.length > 0 || shortlist.length > 0) && (
                  <ShortlistTray
                    items={shortlist}
                    dragOver={dragOver}
                    disabled={loading}
                    onRemove={(id) =>
                      updateShortlist(shortlist.filter((x) => x.id !== id))
                    }
                    onSelect={setSelectedId}
                    onCompare={() => ask("帮我比较一下候选栏里的这几个地方")}
                  />
                )}
              </div>
            </div>
            <LayoutSwitch
              layout={shownLayout}
              onChange={setLayout}
              constraints={constraints}
              count={candidates.length}
            />
          </>
        )}
      </section>
    </main>
  );
}

// 浏览器定位（WGS-84 坐标）→ 服务端换算成国内城市名；拒绝授权、超时、人在境外都返回 null
function currentCity(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const r = await fetch(
            `/api/locate?lng=${coords.longitude}&lat=${coords.latitude}`,
          );
          resolve((await r.json()).city ?? null);
        } catch {
          resolve(null);
        }
      },
      () => resolve(null),
      { timeout: 8000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

// 某一项改了完成状态之后：这一天的条目全部完成，这一天也就完成了；有一项没完成，这一天就不算完成
function withDayDone(d: ItineraryDay): ItineraryDay {
  return { ...d, done: d.items.length > 0 && d.items.every((x) => x.done) };
}

function patchPlan(
  id: number,
  body: {
    status?: PlanStatus;
    shortlist?: Candidate[];
    constraints?: Constraints;
    itinerary?: Itinerary;
  },
) {
  fetch(`/api/plans/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// 规划状态：待开始 / 已完成，点击切换
export function StatusButton({
  status,
  onToggle,
}: {
  status: PlanStatus;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      title="点击切换状态"
      className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${
        status === "已完成"
          ? "bg-gray-900 text-white"
          : "border border-amber-300 bg-amber-50 text-amber-800"
      }`}
    >
      {status === "已完成" ? "✓ 已完成" : "待开始"}
    </button>
  );
}

// 右侧顶部正中的胶囊，三档：全屏路书 / 路书和地图各占一半 / 全屏地图（生成行程之后不再显示）
function LayoutSwitch({
  layout,
  onChange,
  constraints,
  count,
}: {
  layout: Layout;
  onChange: (v: Layout) => void;
  constraints: Constraints | null;
  count: number;
}) {
  const ready = constraints && !missingRequired(constraints).length;
  const tabs: { key: Layout; label: string }[] = [
    { key: "roadbook", label: ready ? "路书 ✓" : "路书" },
    { key: "split", label: "各占一半" },
    { key: "map", label: count ? `地图 · ${count}` : "地图" },
  ];
  return (
    <div className="absolute left-1/2 top-4 z-30 flex -translate-x-1/2 rounded-full border border-gray-200 bg-white/95 p-1 shadow-sm backdrop-blur">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm transition-colors ${
            t.key === "split" ? "max-md:hidden " : ""
          }${
            layout === t.key
              ? "bg-gray-900 text-white"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

type ChatTab = "plan" | "during" | "after";

const CHAT_TABS: { key: ChatTab; label: string }[] = [
  { key: "plan", label: "规划" },
  { key: "during", label: "旅行中" },
  { key: "after", label: "旅行后" },
];

// 还没有行程（或还没存档）时，旅行中 / 旅行后书签里的说明
function TabPlaceholder({ tab }: { tab: ChatTab }) {
  const text =
    tab === "during"
      ? {
          title: "旅行中",
          body: "先在「规划」里生成逐日行程。出发那天点「出发」，之后在这里告诉 TT 路上的情况，并在时间轴上随手写记录。",
        }
      : {
          title: "旅行后",
          body: "先在「规划」里生成逐日行程。回来以后在这里和 TT 聊聊这趟旅行，它会把行程、路上的记录和照片写成游记。",
        };
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
      <p className="text-base font-semibold text-gray-900">{text.title}</p>
      <p className="mt-2 text-sm leading-6 text-gray-500">{text.body}</p>
    </div>
  );
}
