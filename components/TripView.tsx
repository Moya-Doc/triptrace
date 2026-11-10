"use client";

import { CameraOutlined, CheckOutlined, CloseOutlined, CoffeeOutlined, CompassOutlined, EnvironmentOutlined, PlusOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { formatDate, formatMinutes } from "@/components/ItineraryView";
import { legMode, legText, MODE_EMOJI } from "@/lib/leg-format";
import { toClock, toMinutes } from "@/lib/load";
import { shrink } from "@/lib/shrink-photo";
import { diffDay, noteKey, stopsOf, UNPLANNED } from "@/lib/trip";
import type { Departure, Itinerary, ItineraryDay, ItineraryItem, TripNote } from "@/lib/types";

// "旅行中"书签的右边：以规划时的时间轴为底，卡片缩到只有照片那么宽，右边留出地方写记录（文字 + 自己的照片）。
// 行程还是同一份（路上 TT 改的、规划页改的都在这里），点「出发」时存下的计划只用来对比：
// 时间变了标"原计划 10:00"，出发后新加的标出来，取消的用虚线留在原处。
// 过去的日子只能写记录；还没到的日子先不写

type Props = {
  planId: number;
  itinerary: Itinerary;
  departure: Departure | null;
  notes: Record<string, TripNote>;
  // 旅行中左边"今天"的第几天、刚到哪（模拟或真实）；不知道时为 null
  live: { day: number; at: string } | null;
  // 每次加一：滚到"现在在这"（旅行中 TT 改了行程之后）
  focusNow: number;
  onDepart: () => void;
  onSaveNote: (key: string, note: { text: string; photos: string[] }) => Promise<void>;
  onOpenItem: (dayIndex: number, title: string) => void;
  onToggleItem: (dayIndex: number, itemIndex: number) => void;
};

export default function TripView(props: Props) {
  const { itinerary, departure, live, focusNow } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusNow) rootRef.current?.querySelector("[data-here]")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusNow]);

  if (!departure)
    return (
      <div className="flex h-full items-center justify-center bg-[#f4f3ef] px-8">
        <div className="max-w-md space-y-4 rounded-2xl bg-white p-8 text-center shadow-sm">
          <p className="text-xl font-semibold text-gray-900">准备出发了吗？</p>
          <p className="text-sm leading-6 text-gray-600">
            点「出发」时，TT 会把现在的行程存一份「出发时的计划」。路上的调整照常改行程，这一份只用来对比计划和实际。之后每个地方都可以随手写几句、放几张自己拍的照片，回来写游记时直接用上。
          </p>
          <button onClick={props.onDepart} className="w-full rounded-lg bg-teal-700 py-2.5 text-white">
            出发
          </button>
        </div>
      </div>
    );

  const at = new Date(departure.at);
  return (
    <div ref={rootRef} className="h-full overflow-y-auto bg-[#f4f3ef]">
      <div className="mx-auto max-w-4xl px-4 py-8 md:px-8">
        <h2 className="text-2xl font-bold tracking-tight text-gray-900">{itinerary.title}</h2>
        <p className="mt-1.5 text-xs text-gray-500">
          {at.getMonth() + 1} 月 {at.getDate()} 日 {toClock(at.getHours() * 60 + at.getMinutes())} 出发 · 时间轴和规划页是同一份行程，标注的是和出发时计划的不同
        </p>

        <div className="relative mt-8 pb-6">
          <div className="absolute bottom-8 left-[23px] top-6 w-0.5 bg-gray-300" />
          {itinerary.days.map((d) => (
            <Day
              key={d.index}
              {...props}
              day={d}
              base={departure.itinerary.days.find((b) => b.index === d.index)}
              phase={live === null ? "unknown" : d.index < live.day ? "past" : d.index === live.day ? "today" : "future"}
            />
          ))}
        </div>
        <p className="pb-10 text-xs text-gray-400">记录离开输入框时自动保存。照片只存在你自己的电脑上（data/uploads）。</p>
      </div>
    </div>
  );
}

type Phase = "past" | "today" | "future" | "unknown";

function Day(props: Props & { day: ItineraryDay; base: ItineraryDay | undefined; phase: Phase }) {
  const { day: d, base, phase, live } = props;
  const diff = diffDay(d, base);
  const stops = stopsOf(d);
  const hereIdx = phase === "today" && live ? stops.findIndex((x) => x.title === live.at) : -1;
  // 取消的条目放在原计划里它前面那一项的后面
  const removedAfter = new Map<string, ItineraryItem[]>();
  if (base) {
    const baseStops = stopsOf(base);
    for (const r of diff.removed) {
      const prev = baseStops.slice(0, baseStops.indexOf(r)).reverse().find((x) => stops.some((s) => s.title === x.title));
      const k = prev?.title ?? "";
      removedAfter.set(k, [...(removedAfter.get(k) ?? []), r]);
    }
  }
  const badge = { past: "已结束 · 只能写记录", today: "今天", future: "还没到", unknown: "" }[phase];

  return (
    <section className="space-y-3 pb-10">
      <div className="grid grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[48px_112px_minmax(0,1fr)] items-start gap-x-4">
        <span
          className={`relative z-10 flex h-12 w-12 items-center justify-center rounded-full border-4 text-xl ${
            phase === "today" ? "border-teal-700 bg-teal-700 text-white" : d.done ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 bg-white text-gray-500"
          }`}
        >
          {d.done ? <CheckOutlined /> : <EnvironmentOutlined />}
        </span>
        <div className="pt-1.5">
          <div className="text-sm font-semibold text-gray-900">第 {d.index + 1} 天</div>
          <div className="mt-0.5 text-xs text-gray-500">{d.date ? formatDate(d.date) : ""}</div>
        </div>
        <div className="flex items-center gap-3 pt-2.5 max-md:col-start-2">
          <h3 className="text-xl font-bold text-gray-900">{d.city}</h3>
          {badge && (
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs ${
                phase === "today" ? "bg-teal-50 text-teal-800" : "bg-gray-200 text-gray-600"
              }`}
            >
              {badge}
            </span>
          )}
        </div>
      </div>

      {removedAfter.get("")?.map((r) => <Removed key={r.title} item={r} />)}
      {d.items.map((it, i) => {
        if (it.kind === "transit") {
          if (!it.local) return null;
          return (
            <div key={i} className="grid grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[48px_112px_minmax(0,1fr)] gap-x-4">
              <span />
              <span className="max-md:hidden" />
              <span className="px-1 text-xs text-gray-500">
                <span aria-hidden>{MODE_EMOJI[legMode(it)]}</span> {legText(it)}
              </span>
            </div>
          );
        }
        if (it.kind === "stay") return null;
        const stopIdx = stops.indexOf(it);
        const key = noteKey(d.index, it.title);
        return (
          <div key={i} className="space-y-3">
            <Stop
              {...props}
              item={it}
              itemIndex={i}
              note={props.notes[key]}
              noteKey={key}
              added={diff.added.has(it.title)}
              planned={diff.moved.get(it.title) ?? null}
              here={stopIdx === hereIdx}
              passed={hereIdx >= 0 && stopIdx < hereIdx}
            />
            {removedAfter.get(it.title)?.map((r) => <Removed key={r.title} item={r} />)}
          </div>
        );
      })}
      {/* 行程里没有的地方（对话里说的"路过一家茶馆"），记在这一天的最后 */}
      {props.notes[noteKey(d.index, UNPLANNED)] && (
        <div className="grid grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[48px_112px_minmax(0,1fr)] items-start gap-x-4">
          <span />
          <div className="pt-2 text-sm font-semibold text-gray-900">计划外</div>
          <NoteBox
            {...props}
            phase={phase}
            note={props.notes[noteKey(d.index, UNPLANNED)]}
            noteKey={noteKey(d.index, UNPLANNED)}
            key={props.notes[noteKey(d.index, UNPLANNED)].updatedAt}
          />
        </div>
      )}
    </section>
  );
}

function Stop(
  props: Props & {
    day: ItineraryDay;
    phase: Phase;
    item: ItineraryItem;
    itemIndex: number;
    note: TripNote | undefined;
    noteKey: string;
    added: boolean;
    planned: string | null;
    here: boolean;
    passed: boolean;
  },
) {
  const { day: d, item: it, added, planned, here, passed } = props;
  const meal = it.kind === "free" && /餐/.test(it.title);
  const photo = it.kind === "place" ? it.photo : (it.venue?.photo ?? null);
  const name = meal ? (it.venue?.name ?? it.title) : it.title;
  const end = it.start ? toClock(toMinutes(it.start) + it.minutes) : null;
  return (
    <div data-here={here || undefined} className="grid grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[48px_112px_minmax(0,1fr)] items-start gap-x-4">
      <button
        onClick={() => props.onToggleItem(d.index, props.itemIndex)}
        title={it.done ? "标记为没去" : "标记为去过了"}
        aria-label={`${name}：${it.done ? "去过了" : "还没去"}`}
        className={`relative z-10 mx-0.5 mt-1 flex h-11 w-11 items-center justify-center rounded-full border-2 text-lg ${
          it.done ? "border-gray-900 bg-gray-900 text-white" : here ? "border-teal-700 bg-white text-teal-700" : "border-gray-300 bg-white text-gray-500"
        }`}
      >
        {it.done ? <CheckOutlined /> : meal ? <CoffeeOutlined /> : it.kind === "free" ? <CompassOutlined /> : <CameraOutlined />}
      </button>
      <div className="pt-2">
        <div className={`text-sm font-semibold tabular-nums ${passed ? "text-gray-400" : "text-gray-900"}`}>
          {it.start && end ? `${it.start}–${end}` : formatMinutes(it.minutes)}
        </div>
        {here && <div className="mt-0.5 text-xs font-semibold text-teal-700">现在在这</div>}
        {planned && <div className="mt-0.5 text-xs text-amber-700">原计划 {planned}</div>}
        {added && <div className="mt-0.5 text-xs text-teal-700">出发后新加的</div>}
      </div>
      <div className="flex flex-col gap-3 max-md:col-start-2 max-md:mt-2 md:flex-row md:items-start md:gap-4">
        {/* 卡片缩到照片的宽度（手机上占满一行，记录排在下面）：点一下打开这一天的详情 */}
        <button
          onClick={() => props.onOpenItem(d.index, it.title)}
          className={`w-full shrink-0 overflow-hidden rounded-xl bg-white text-left shadow-sm md:w-[152px] ${passed || it.done ? "opacity-60" : ""}`}
          title="打开这一天的详情"
        >
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- 高德图片域名不固定，不走 next/image 优化
            <img src={photo} alt="" referrerPolicy="no-referrer" className="h-32 w-full object-cover md:h-[95px] md:w-[152px]" />
          ) : (
            <span className="flex h-32 w-full items-center md:h-[95px] md:w-[152px] justify-center bg-gray-100 text-2xl text-gray-400">
              {meal ? <CoffeeOutlined /> : <CameraOutlined />}
            </span>
          )}
          <span className="block px-2.5 py-1.5">
            {meal && <span className="block text-[11px] text-gray-500">{it.title}</span>}
            <span className="block truncate text-sm font-semibold text-gray-900">{name}</span>
          </span>
        </button>
        {/* 对话里的感受被记进来时（updatedAt 变了）重新读一遍 */}
        <NoteBox {...props} key={`${props.noteKey}@${props.note?.updatedAt ?? ""}`} />
      </div>
    </div>
  );
}

// 一条记录：文字（离开输入框时保存）+ 自己拍的照片。还没到的日子先不写
function NoteBox(props: Props & { phase: Phase; note: TripNote | undefined; noteKey: string }) {
  const { planId, phase, note, noteKey: key, onSaveNote } = props;
  const [text, setText] = useState(note?.text ?? "");
  const [photos, setPhotos] = useState(note?.photos ?? []);
  const [state, setState] = useState<"idle" | "saving" | "uploading" | "error">("idle");

  if (phase === "future")
    return <p className="flex-1 pt-2 text-xs text-gray-400">到了再写</p>;

  async function save(nextText: string, nextPhotos: string[]) {
    setState("saving");
    try {
      await onSaveNote(key, { text: nextText, photos: nextPhotos });
      setState("idle");
    } catch {
      setState("error");
    }
  }

  async function upload(file: File) {
    setState("uploading");
    try {
      const form = new FormData();
      form.append("file", await shrink(file), "photo.jpg");
      const res = await fetch(`/api/plans/${planId}/photos`, { method: "POST", body: form });
      const data = await res.json();
      if (!data.ok) return setState("error");
      const next = [...photos, data.url as string];
      setPhotos(next);
      await save(text, next);
    } catch {
      setState("error");
    }
  }

  return (
    <div className="min-w-0 flex-1 space-y-2 max-md:col-start-2">
      <textarea
        value={text}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== (note?.text ?? "") && save(text, photos)}
        placeholder="写几句：好不好玩、遇到了什么、吃了什么…"
        aria-label="这里的记录"
        className="w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm leading-6 text-gray-800 outline-none placeholder:text-gray-400 focus:border-teal-600"
      />
      <div className="flex flex-wrap items-center gap-2">
        {photos.map((p) => (
          <span key={p} className="group relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- 自己上传的照片 */}
            <img src={p} alt="" className="h-14 w-14 rounded-lg object-cover" />
            <button
              onClick={() => {
                const next = photos.filter((x) => x !== p);
                setPhotos(next);
                save(text, next);
              }}
              aria-label="删掉这张照片"
              className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-white text-[10px] text-gray-600 shadow group-hover:flex max-md:flex"
            >
              <CloseOutlined />
            </button>
          </span>
        ))}
        <label className="flex h-14 w-14 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 text-[11px] text-gray-500 hover:border-teal-600">
          <PlusOutlined />
          照片
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = "";
            }}
          />
        </label>
        {note?.fromChat && <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] text-teal-800">含旅行中对话里说的</span>}
        <span className="text-xs text-gray-400">
          {state === "saving" ? "保存中…" : state === "uploading" ? "上传中…" : state === "error" ? "没保存上，再试一次" : ""}
        </span>
      </div>
    </div>
  );
}

// 原计划里有、出发后取消了的：虚线留在原来的位置
function Removed({ item: it }: { item: ItineraryItem }) {
  return (
    <div className="grid grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[48px_112px_minmax(0,1fr)] items-center gap-x-4">
      <span />
      <span className="text-xs tabular-nums text-gray-400 line-through">{it.start ?? ""}</span>
      <span className="w-fit rounded-xl border border-dashed max-md:col-start-2 border-gray-300 px-3 py-1.5 text-xs text-gray-500">
        原计划：<span className="line-through">{it.venue ? `${it.title}·${it.venue.name}` : it.title}</span> · 出发后取消了
      </span>
    </div>
  );
}
