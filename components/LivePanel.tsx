"use client";

import { useEffect, useRef, useState } from "react";
import RichText from "@/components/RichText";
import ErrorNote from "@/components/ErrorNote";
import { toClock, toMinutes } from "@/lib/load";
import type { ChatMessage, Itinerary, ItineraryDay, TripNote } from "@/lib/types";

// "旅行中"书签的左边：人在路上时用。上半部分是"今天"：现在几点、在哪、几点到的、比计划早还是晚（今天的完整时间轴在右边）；
// 下半部分是和 TT 的对话，输入框上方有一键情况按钮（我晚了、下雨了、太累了、这里关门了）。
// TT 只改今天还没去的和以后几天；改动和规划时一样能撤销。
// 演示时行程不在今天、人也不在当地，所以有"模拟时间和位置"的开关

type Undo = { count: number; last: string | null };
type LiveState = { day: number; now: string; at: string; arrived?: string };

const QUICK = ["我晚了，后面帮我顺一下", "下雨了", "太累了，想轻松点", "这里关门了"];

export default function LivePanel(props: {
  planId: number;
  itinerary: Itinerary;
  initialMessages: ChatMessage[];
  onItinerary: (it: Itinerary) => void;
  onUndo: (u: Undo | undefined) => void;
  // TT 改了行程：右边的时间轴滚到"现在在这"（不再自动打开当日详情）
  onChanged: () => void;
  // 点了「出发」才开始（右边有出发按钮）；出发时存下的计划用来算"比计划早 / 晚"
  departed: boolean;
  baseline: Itinerary | null;
  // 告诉右边的时间轴：今天是第几天、刚到哪（不在行程里时为 null）
  onLive: (live: { day: number; at: string } | null) => void;
  // 对话里说的感受被记进了记录：交给右边的时间轴
  onNotes: (notes: Record<string, TripNote>) => void;
}) {
  const { planId, itinerary, onItinerary, onUndo, onChanged, departed, baseline, onLive, onNotes } = props;
  const [messages, setMessages] = useState<ChatMessage[]>(props.initialMessages);
  const [suggestions, setSuggestions] = useState<string[]>(QUICK);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulate, setSimulate] = useState(true);
  // 说到了还没到的地方：TT 问"是不是已经到了"，这里给一个"到了，更新位置"的按钮
  const [relocate, setRelocate] = useState<{ day: number; at: string; start: string | null } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<(() => void) | null>(null);

  // 真实模式：按今天的日期和现在的时间；模拟模式：自己选第几天、几点、在哪
  const realToday = itinerary.days.find((d) => d.date === localDate());
  const [sim, setSim] = useState<LiveState>(() => {
    const d = itinerary.days[Math.min(1, itinerary.days.length - 1)];
    const first = stops(d)[0];
    const now = first?.start ?? "10:00";
    return { day: d.index, now, at: first?.title ?? "", arrived: now };
  });
  const [realAt, setRealAt] = useState<string | null>(null);
  const [realArrived, setRealArrived] = useState<string | null>(null);

  const day = simulate ? itinerary.days.find((d) => d.index === sim.day) : realToday;
  const now = simulate ? sim.now : toClock(new Date().getHours() * 60 + new Date().getMinutes());
  const list = day ? stops(day) : [];
  // 真实模式下默认"在"按计划此刻应该在的地方
  const plannedHere =
    list.find((x) => x.start && toMinutes(x.start) <= toMinutes(now) && toMinutes(x.start) + x.minutes > toMinutes(now)) ??
    list.find((x) => x.start && toMinutes(x.start) > toMinutes(now)) ??
    list.at(-1);
  const at = simulate ? sim.at : (realAt ?? plannedHere?.title ?? "");
  const here = list.find((x) => x.title === at);
  // 几点到的：模拟时自己填；真实模式下，按计划自动定位的就当作按计划时间到的，自己选了地方就当作刚到（都可以改）
  const arrived = clampTo(
    simulate ? (sim.arrived ?? now) : (realArrived ?? (realAt ? now : (here?.start ?? now))),
    now,
  );
  // "计划"指出发时的计划：按现在重排之后，行程里的时间已经是实际到达的时间，和它比永远是"差不多"
  const baseDay = baseline?.days.find((d) => d.index === day?.index);
  const planned = (baseDay ? stops(baseDay).find((x) => x.title === at)?.start : null) ?? here?.start ?? null;
  const late = planned ? toMinutes(arrived) - toMinutes(planned) : 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  const dayIndex = day?.index ?? null;
  useEffect(() => {
    onLive(dayIndex === null ? null : { day: dayIndex, at });
  }, [dayIndex, at, onLive]);

  async function call(action: "sync" | "say", text?: string, override?: LiveState, retrying = false) {
    if ((!override && (!day || !at)) || busy) return;
    const state: LiveState = override ?? { day: day!.index, now, at, arrived };
    const before = JSON.stringify(itinerary.days);
    setRelocate(null);
    if (text && !retrying) setMessages((m) => [...m, { role: "user", content: text }]);
    // 重试：说的话按当时的时间和位置；重排按现在模拟栏里的（用户可能刚改过）
    retryRef.current = () => call(action, text, action === "say" ? state : override, true);
    setInput("");
    setError(null);
    setBusy(action === "sync" ? "正在按现在的时间和位置重排今天…" : "TT 正在看怎么调整…");
    try {
      const res = await fetch(`/api/plans/${planId}/live`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, state, text }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error);
        return;
      }
      onItinerary(data.itinerary);
      setMessages(data.messages);
      setSuggestions(data.suggestions?.length ? data.suggestions : QUICK);
      onUndo(data.undo);
      if (data.notes) onNotes(data.notes);
      if (data.relocate) {
        setRelocate(data.relocate);
        return;
      }
      // 行程真的改了，右边的时间轴滚到"现在在这"；只是聊天、提议、记感受时右边不动
      if (JSON.stringify(data.itinerary.days) !== before) onChanged();
    } catch {
      setError("连不上服务器，请确认开发服务器还在运行");
    } finally {
      setBusy(null);
    }
  }

  // 确认已经到了：把位置（模拟时还有第几天、几点）改过去，按现在重排；先放着的感受这时记上
  function arrive(r: { day: number; at: string; start: string | null }) {
    if (simulate) {
      // 模拟的时间还早于那个地方的计划时间，就拨到计划时间
      const t = r.start && (r.day !== sim.day || toMinutes(r.start) > toMinutes(sim.now)) ? r.start : sim.now;
      const next = { day: r.day, now: t, at: r.at, arrived: t };
      setSim(next);
      call("sync", undefined, next);
    } else {
      setRealAt(r.at);
      setRealArrived(now);
      call("sync", undefined, { day: r.day, now, at: r.at, arrived: now });
    }
  }

  if (!departed)
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <p className="text-base font-semibold text-gray-900">旅行中</p>
        <p className="mt-2 text-sm leading-6 text-gray-500">
          出发那天点右边的「出发」。之后在这里告诉 TT 路上的情况（晚了、下雨了、太累了、闭馆了），它会调整今天还没去的部分；右边的时间轴上可以随手写记录。
        </p>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 今天 */}
      <div className="space-y-3 border-b border-gray-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-500">今天</p>
          <label className="flex items-center gap-1.5 text-xs text-gray-500">
            <input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} />
            演示：模拟时间和位置
          </label>
        </div>

        {simulate && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
            <select
              value={sim.day}
              onChange={(e) => {
                const d = itinerary.days.find((x) => x.index === Number(e.target.value))!;
                const first = stops(d)[0];
                const t = first?.start ?? sim.now;
                setSim({ day: d.index, now: t, at: first?.title ?? "", arrived: t });
              }}
              className="rounded border border-amber-200 bg-white px-1 py-0.5"
            >
              {itinerary.days.map((d) => (
                <option key={d.index} value={d.index}>
                  第 {d.index + 1} 天 {d.city}
                </option>
              ))}
            </select>
            <span>现在</span>
            {/* 把"现在"往后拨，到达时间不变：就是"在这个地方已经待了一会儿" */}
            <ClockInput
              value={sim.now}
              label="模拟的现在时间"
              onCommit={(t) => setSim({ ...sim, now: t, arrived: clampTo(sim.arrived ?? t, t) })}
              className="border-amber-200"
            />
            <span>在</span>
            <select
              value={sim.at}
              onChange={(e) => setSim({ ...sim, at: e.target.value, arrived: sim.now })}
              className="max-w-[160px] rounded border border-amber-200 bg-white px-1 py-0.5"
            >
              {(day ? stops(day) : []).map((x) => (
                <option key={x.title} value={x.title}>
                  {label(x)}
                </option>
              ))}
            </select>
            <ClockInput
              value={arrived}
              label="几点到的"
              onCommit={(t) => setSim({ ...sim, arrived: clampTo(t, sim.now) })}
              className="border-amber-200"
            />
            <span>到的</span>
          </div>
        )}

        {!day ? (
          <p className="text-sm text-gray-500">
            {itinerary.days[0]?.date
              ? `行程从 ${itinerary.days[0].date} 开始，今天还没出发。可以打开上面的"演示"试试。`
              : "今天不在行程里。可以打开上面的“演示”试试。"}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-semibold text-gray-900">
                第 {day.index + 1} 天 · {day.city}
              </span>
              <span className="text-gray-500">现在 {now}</span>
              {!simulate && (
                <>
                  <select
                    value={at}
                    onChange={(e) => {
                      setRealAt(e.target.value);
                      setRealArrived(now);
                    }}
                    className="rounded border border-gray-200 px-1 py-0.5 text-xs"
                    aria-label="我现在在"
                  >
                    {list.map((x) => (
                      <option key={x.title} value={x.title}>
                        在 {label(x)}
                      </option>
                    ))}
                  </select>
                  <span className="flex items-center gap-1 text-xs text-gray-500">
                    <ClockInput value={arrived} label="几点到的" onCommit={(t) => setRealArrived(clampTo(t, now))} className="border-gray-200" />
                    到的
                  </span>
                </>
              )}
            </div>
            {here && (
              <p className={`text-sm ${late > 15 ? "text-red-600" : late < -15 ? "text-teal-700" : "text-gray-600"}`}>
                {arrived === now ? "刚到" : `${arrived} 到的`}「{label(here)}」：
                {late > 5 ? `比计划晚了 ${late} 分钟` : late < -5 ? `比计划早了 ${-late} 分钟` : "和计划差不多"}
                （计划 {planned ?? "--:--"}）
              </p>
            )}
            <button
              onClick={() => call("sync")}
              disabled={Boolean(busy) || !at}
              className="w-full rounded-lg bg-teal-700 py-2 text-sm text-white disabled:opacity-40"
            >
              按现在的时间和位置，重排今天剩下的
            </button>
          </>
        )}
      </div>

      {/* 对话 */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <p className="text-sm leading-6 text-gray-500">
            路上计划被打乱了？告诉 TT 现在的情况，它只会调整今天还没去的部分，去过的不会动；改了也能撤销。
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
            <div key={i} className="text-sm leading-7 text-gray-800">
              <RichText text={m.content} />
            </div>
          ),
        )}
        {relocate && !busy && (
          <div className="flex flex-wrap gap-2">
            <button onClick={() => arrive(relocate)} className="rounded-full bg-teal-700 px-3 py-1 text-xs text-white">
              到了，更新位置到「{relocate.at}」
            </button>
            <button
              onClick={() => setRelocate(null)}
              className="rounded-full border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:border-teal-600"
            >
              还没到，刚才说的不算
            </button>
          </div>
        )}
        {busy && <div className="text-sm text-gray-400">{busy}</div>}
        {error && <ErrorNote message={error} onRetry={busy ? undefined : () => retryRef.current?.()} />}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-gray-200 p-3">
        {day && !busy && (
          <div className="mb-2 flex flex-wrap gap-2">
            {suggestions.map((t) => (
              <button
                key={t}
                onClick={() => call("say", t)}
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
            if (input.trim()) call("say", input.trim());
          }}
          className="flex items-end gap-2"
        >
          <textarea
            value={input}
            rows={2}
            disabled={!day}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (input.trim()) call("say", input.trim());
              }
            }}
            placeholder="说说现在的情况，比如：排队太久了，后面的帮我压缩一下"
            className="flex-1 resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-teal-600 disabled:bg-gray-50"
          />
          <button
            type="submit"
            disabled={Boolean(busy) || !input.trim() || !day}
            className="rounded-lg bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            发送
          </button>
        </form>
      </div>
    </div>
  );
}

// 时:分 输入框：边输边改草稿，离开或回车时检查格式再提交（格式不对就恢复原值）
function ClockInput({ value, label, onCommit, className }: { value: string; label: string; onCommit: (t: string) => void; className: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  function commit() {
    const m = (draft ?? "").trim().match(/^(\d{1,2})[:：.]?(\d{2})$/);
    if (m && Number(m[1]) < 24 && Number(m[2]) < 60) onCommit(`${m[1].padStart(2, "0")}:${m[2]}`);
    setDraft(null);
  }
  return (
    <input
      value={draft ?? value}
      maxLength={5}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      aria-label={label}
      className={`w-14 rounded border bg-white px-1 py-0.5 text-center tabular-nums ${className}`}
    />
  );
}

// 到达时间不能晚于现在
function clampTo(arrived: string, now: string) {
  return toMinutes(arrived) > toMinutes(now) ? now : arrived;
}

// 这一天的景点和用餐（按顺序）
function stops(d: ItineraryDay) {
  return d.items.filter((x) => x.kind === "place" || x.kind === "free");
}

function label(x: { title: string; venue?: { name: string } | null }) {
  return x.venue ? `${x.title}·${x.venue.name}` : x.title;
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
