"use client";

import Icon, {
  CameraOutlined,
  CarOutlined,
  CheckOutlined,
  CoffeeOutlined,
  CompassOutlined,
  EnvironmentOutlined,
  HomeOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { prefetchPlace, type PlaceInfo } from "@/components/DayPanels";
import { useIsMobile } from "@/components/PaneSwitch";
import { legMode, legText, MODE_EMOJI } from "@/lib/leg-format";
import { dayLoad, dayWindow, toClock, toMinutes, transitHeavy } from "@/lib/load";
import type { Itinerary, ItineraryDay, ItineraryItem } from "@/lib/types";

// 逐日行程：固定模板的纵向时间轴（参照 Layla）。对话和 LLM 只决定每个栏位里填什么，不改变版式。
// 每一行三栏：圆点 / 两行标签（这是什么 + 日期）/ 卡片。
// 圆点：一天的目的地、到达（城际交通）、景点、住宿。每个圆点都能单独点击标记完成，完成后变成深色。
// 同城内的车程和用餐不单独占圆点，作为两张卡片之间的细条显示。
// 景点和用餐可以上下拖动：拖动时其他栏目会上下浮动让出位置，松手后服务端重新计算车程和时间

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const GAP = 12;

type Props = {
  itinerary: Itinerary;
  onToggleDay: (index: number) => void;
  onToggleItem: (dayIndex: number, itemIndex: number) => void;
  onReorder: (dayIndex: number, order: ItineraryItem[], legs?: undefined, label?: string) => Promise<void>;
  // 点一下景点（没有拖动）：打开这一天的详情
  onOpenItem: (dayIndex: number, title: string) => void;
  // 改这一天的活动时间段（城市名后面的时间）
  onChangeWindow: (dayIndex: number, start: string, end: string) => void;
};

export default function ItineraryView({ itinerary, onToggleDay, onToggleItem, onReorder, onOpenItem, onChangeWindow }: Props) {
  const first = itinerary.days[0]?.date;
  const last = itinerary.days[itinerary.days.length - 1]?.date;
  return (
    <div className="h-full overflow-y-auto bg-[#f4f3ef]">
      <div className="relative h-60 w-full overflow-hidden">
        {itinerary.banner && (
          // eslint-disable-next-line @next/next/no-img-element -- 高德图片域名不固定，不走 next/image 优化
          <img src={itinerary.banner} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#f4f3ef]/30 to-[#f4f3ef]" />
      </div>

      <div className="mx-auto max-w-4xl px-4 md:px-8">
        <h2 className="text-3xl font-bold tracking-tight text-gray-900">{itinerary.title}</h2>
        <p className="mt-2 text-sm text-gray-500">
          {first && last ? `${formatDate(first)} – ${formatDate(last)} · ` : ""}共 {itinerary.days.length} 天
        </p>

        <div className="relative mt-10 pb-6">
          {/* 贯穿整个行程的竖线，穿过所有圆点的中心 */}
          <div className="absolute bottom-8 left-[23px] top-6 w-0.5 bg-gray-300" />
          {itinerary.days.map((d) => (
            <Day
              key={d.index}
              day={d}
              onToggleDay={() => onToggleDay(d.index)}
              onToggleItem={(i) => onToggleItem(d.index, i)}
              onReorder={(order) => onReorder(d.index, order, undefined, `调整第 ${d.index + 1} 天的顺序`)}
              onOpen={(title) => onOpenItem(d.index, title)}
              onChangeWindow={(start, end) => onChangeWindow(d.index, start, end)}
            />
          ))}
        </div>
        <p className="pb-10 text-xs text-gray-400">
          地点、交通、住宿和车程来自高德地图；介绍、停留时长和时间安排是 TT 的建议。点圆点标记完成，点景点打开当天详情，拖动景点或用餐可以调整顺序。
        </p>
      </div>
    </div>
  );
}

type Drag = { from: number; target: number; dy: number; height: number };

function Day(props: {
  day: ItineraryDay;
  onToggleDay: () => void;
  onToggleItem: (i: number) => void;
  onReorder: (order: ItineraryItem[]) => Promise<void>;
  onOpen: (title: string) => void;
  onChangeWindow: (start: string, end: string) => void;
}) {
  const { day: d, onToggleDay, onToggleItem, onReorder, onOpen, onChangeWindow } = props;
  const [drag, setDrag] = useState<Drag | null>(null);
  const isMobile = useIsMobile();
  const [saving, setSaving] = useState(false);
  const rows = useRef(new Map<number, HTMLDivElement>());
  const movable = (x: ItineraryItem) => x.kind === "place" || x.kind === "free";

  // 拖动（指针事件，鼠标和触屏都能用）：开始时记下每一栏的位置；
  // 指针越过某个可拖栏目的中线，就把它当成新位置，中间的栏目整体上移或下移一个身位
  function startDrag(down: React.PointerEvent, from: number) {
    if (saving || down.button !== 0) return;
    // 手机上手指滑动是滚动页面，不是拖动；点一下仍然打开详情（调整顺序跟 TT 说）
    const scrolls = down.pointerType === "touch" && isMobile;
    const rects = new Map([...rows.current].map(([i, el]) => [i, el.getBoundingClientRect()]));
    const height = (rects.get(from)?.height ?? 0) + GAP;
    const startY = down.clientY;
    let active = false;
    let target = from;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      if (!active && Math.abs(dy) < 5) return;
      if (scrolls) return stop();
      active = true;
      target = from;
      d.items.forEach((x, i) => {
        const r = rects.get(i);
        if (!r || i === from || !movable(x)) return;
        const mid = r.top + r.height / 2;
        if (i > from && ev.clientY > mid) target = Math.max(target, i);
        if (i < from && ev.clientY < mid) target = Math.min(target, i);
      });
      setDrag({ from, target, dy, height });
    };
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", stop);
      setDrag(null);
    };
    const up = () => {
      stop();
      if (active && target !== from) drop(from, target);
      // 没有拖动，就是点击：打开这一天的详情
      else if (!active) onOpen(d.items[from].title);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", stop);
  }

  async function drop(from: number, target: number) {
    const core = d.items.map((x, i) => ({ x, i })).filter(({ x }) => movable(x));
    const order = core.map(({ x }) => x);
    const a = core.findIndex(({ i }) => i === from);
    const b = core.findIndex(({ i }) => i === target);
    const [moved] = order.splice(a, 1);
    // 拖动 = 用户想按新顺序来，被拖动的这一项不再固定原来的时间，按新位置重新分配
    order.splice(b, 0, { ...moved, pinned: false });
    setSaving(true);
    await onReorder(order);
    setSaving(false);
  }

  function shift(i: number): React.CSSProperties {
    if (!drag) return {};
    if (i === drag.from) {
      return { transform: `translateY(${drag.dy}px) scale(1.02)`, zIndex: 20, position: "relative" };
    }
    const { from, target, height } = drag;
    let y = 0;
    if (from < target && i > from && i <= target) y = -height;
    if (target < from && i >= target && i < from) y = height;
    return { transform: `translateY(${y}px)`, transition: "transform 200ms ease" };
  }

  const date = d.date ? shortDate(d.date) : "";
  const leading = d.items.findIndex((x) => !(x.kind === "transit" && !isLocal(x)));
  const arrivals = d.items.slice(0, leading < 0 ? d.items.length : leading);

  return (
    <section className={`space-y-3 pb-10 ${saving ? "opacity-60" : ""}`}>
      {/* 先到达，再介绍目的地：和 Layla 一样，换城的那天先出现"到达"横条 */}
      {arrivals.map((it, i) => (
        <Row
          key={`a${i}`}
          icon={<TransportIcon item={it} />}
          done={Boolean(it.done)}
          onToggle={() => onToggleItem(i)}
          title="到达"
          sub={date}
        >
          <ArriveBar item={it} />
        </Row>
      ))}

      {/* 大点：这一天的目的地和介绍 */}
      <Row
        icon={d.done ? <CheckOutlined /> : <EnvironmentOutlined />}
        done={d.done}
        onToggle={onToggleDay}
        title={`第 ${d.index + 1} 天`}
        sub={d.date ? formatDate(d.date) : ""}
        big
      >
        <div className="pt-1">
          {/* 城市名后面是这一天的活动时间段，点一下可以改；负荷条的总长度按它算 */}
          <div className="flex flex-wrap items-center gap-3">
            <h3 className={`text-xl font-bold ${d.done ? "text-gray-500" : "text-gray-900"}`}>{d.city}</h3>
            <DayWindow day={d} onChange={onChangeWindow} />
          </div>
          {d.intro && <p className="mt-1.5 text-sm leading-6 text-gray-600">{d.intro}</p>}
          <LoadBar day={d} />
        </div>
      </Row>

      {d.items.map((it, i) => {
        if (i < arrivals.length) return null;
        const common = {
          ref: (el: HTMLDivElement | null) => {
            if (el) rows.current.set(i, el);
            else rows.current.delete(i);
          },
          style: shift(i),
        };
        // 城际交通出现在一天的结尾（返程）时，也用"到达"横条
        if (it.kind === "transit" && !isLocal(it)) {
          return (
            <div key={i} {...common}>
              <Row icon={<TransportIcon item={it} />} done={Boolean(it.done)} onToggle={() => onToggleItem(i)} title="返程" sub={date}>
                <ArriveBar item={it} />
              </Row>
            </div>
          );
        }
        // 同城车程：不单独占圆点，作为两张卡片之间的细条
        if (it.kind === "transit") {
          return (
            <div key={i} {...common}>
              <Connector done={Boolean(it.done)}>
                <span aria-hidden>{MODE_EMOJI[legMode(it)]}</span> {legText(it)}
                {it.verified && <span className="ml-2 text-teal-700">高德</span>}
              </Connector>
            </div>
          );
        }
        // 用餐、自由活动：和景点一样的横条，可以拖动，点一下打开这一天的详情。用餐显示附近的餐厅
        if (it.kind === "free") {
          const meal = /餐/.test(it.title);
          return (
            <div key={i} {...common}>
              <Row
                icon={meal ? <CoffeeOutlined /> : <CompassOutlined />}
                done={Boolean(it.done)}
                onToggle={() => onToggleItem(i)}
                title={it.title}
                sub={`${date}${it.start ? ` · ${it.start}` : ""}`}
              >
                <div
                  onPointerDown={(e) => startDrag(e, i)}
                  className={`cursor-grab select-none rounded-xl active:cursor-grabbing md:touch-none ${
                    drag?.from === i ? "shadow-xl" : ""
                  }`}
                >
                  <PhotoCard
                    wide={meal}
                    photo={it.venue?.photo ?? null}
                    fallback={meal ? <CoffeeOutlined /> : <CompassOutlined />}
                    label={meal ? `餐厅 · ${it.title}` : "活动"}
                    title={meal ? (it.venue?.name ?? "附近找家馆子") : it.title}
                    detail={[
                      it.start ? `${it.start}–${endOf(it)}` : `约 ${formatMinutes(it.minutes)}`,
                      it.venue?.near && it.venue.distanceM !== null ? `离${it.venue.near}约 ${it.venue.distanceM} 米` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    verified={Boolean(it.venue)}
                    draggableHint
                    warning={it.hoursIssue}
                  />
                </div>
              </Row>
            </div>
          );
        }
        if (it.kind === "stay") {
          return (
            <div key={i} {...common}>
              <Row
                icon={<HomeOutlined />}
                done={Boolean(it.done)}
                onToggle={() => onToggleItem(i)}
                title="住宿"
                sub={`${date} · 1 晚`}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(it.title)}
                  onKeyDown={(e) => e.key === "Enter" && onOpen(it.title)}
                  className="cursor-pointer"
                  title="打开这一天的详情"
                >
                  <StayCard item={it} />
                </div>
              </Row>
            </div>
          );
        }
        return (
          <div key={i} {...common}>
            <Row
              icon={<CameraOutlined />}
              done={Boolean(it.done)}
              onToggle={() => onToggleItem(i)}
              title="景点"
              sub={`${date}${it.start ? ` · ${it.start}` : ""}`}
            >
              <div
                onPointerDown={(e) => startDrag(e, i)}
                className={`cursor-grab select-none rounded-xl active:cursor-grabbing md:touch-none ${
                  drag?.from === i ? "shadow-xl" : ""
                }`}
              >
                <PhotoCard
                  wide
                  photo={it.photo}
                  fallback={<CameraOutlined />}
                  title={it.title}
                  detail={
                    it.start ? `${it.start}–${endOf(it)} · 停留 ${formatMinutes(it.minutes)}` : `建议停留 ${formatMinutes(it.minutes)}`
                  }
                  verified={it.verified}
                  draggableHint
                  warning={it.hoursIssue}
                />
              </div>
            </Row>
          </div>
        );
      })}
      {saving && <p className="pl-16 text-xs text-gray-500 md:pl-[184px]">正在按新顺序重新计算车程…</p>}
    </section>
  );
}

// 一行：圆点 / 两行标签 / 卡片
function Row(props: {
  icon: React.ReactNode;
  done: boolean;
  onToggle: () => void;
  title: string;
  sub: string;
  big?: boolean;
  children: React.ReactNode;
}) {
  const { icon, done, onToggle, title, sub, big, children } = props;
  return (
    <div className="grid grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[48px_112px_minmax(0,1fr)] items-start gap-x-4">
      {/* 一天的大点用更粗的边框，和景点、住宿的小点区分开 */}
      <div className="relative">
        <button
          onClick={onToggle}
          title={done ? "标记为未完成" : "标记为已完成"}
          aria-label={`${title}：${done ? "已完成" : "未完成"}`}
          className={`relative z-10 flex items-center justify-center rounded-full transition-colors ${
            big ? "h-12 w-12 border-4 text-xl" : "mx-0.5 mt-1 h-11 w-11 border-2 text-lg"
          } ${done ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 bg-white text-gray-500 hover:border-gray-500"}`}
        >
          {icon}
        </button>
      </div>
      <div className={big ? "pt-1.5" : "pt-2"}>
        <div className={`text-sm font-semibold ${done ? "text-gray-400" : "text-gray-900"}`}>{title}</div>
        <div className="mt-0.5 text-xs text-gray-500">{sub}</div>
      </div>
      {/* 完成之后，整张卡片一起变灰，而不只是名字 */}
      <div className={`transition max-md:col-start-2 max-md:mt-2 ${done ? "opacity-50 grayscale" : ""}`}>{children}</div>
    </div>
  );
}

// 到达横条：从一个大地点到另一个大地点，中间是交通方式和时长
function ArriveBar({ item: it }: { item: ItineraryItem }) {
  const [from, to] = it.title.split(" → ");
  return (
    <div className="rounded-2xl bg-white px-5 py-4 shadow-sm">
      <div className="flex items-center gap-4">
        <span className="text-base font-semibold text-gray-900">{from}</span>
        <div className="flex flex-1 flex-col items-center">
          <span className="text-xs text-gray-500">{formatMinutes(it.minutes)}</span>
          <div className="relative mt-1 h-1 w-full rounded-full bg-violet-100">
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-white px-1 text-base text-gray-700">
              <TransportIcon item={it} />
            </span>
          </div>
        </div>
        <span className="text-base font-semibold text-gray-900">{to}</span>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
        <span>{it.via}</span>
        {it.verified && <span className="text-teal-700">数据来源：高德</span>}
      </div>
    </div>
  );
}

// 这一天的活动时间段：平时是一个小标签"09:00–21:00 · 共 12 小时"，点一下变成两个输入框。
// 回车或点"保存"提交，Esc 或"取消"放弃；结束要晚于开始
function DayWindow({ day, onChange }: { day: ItineraryDay; onChange: (start: string, end: string) => void }) {
  const w = dayWindow(day);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ start: w.start, end: w.end });
  const [error, setError] = useState<string | null>(null);

  function open() {
    setDraft({ start: w.start, end: w.end });
    setError(null);
    setEditing(true);
  }

  function commit() {
    const norm = (t: string) => {
      const m = t.trim().match(/^(\d{1,2})[:：.]?(\d{2})$/);
      return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
    };
    const start = norm(draft.start);
    const end = norm(draft.end);
    if (!start || !end) return setError("时间的格式是 时:分，例如 09:30");
    if (toMinutes(end) <= toMinutes(start)) return setError("结束要晚于开始");
    setEditing(false);
    if (start !== w.start || end !== w.end) onChange(start, end);
  }

  if (!editing)
    return (
      <button
        onClick={open}
        title="点一下修改这一天的活动时间"
        className="rounded-full border border-gray-200 bg-white px-2.5 py-0.5 text-xs text-gray-600 hover:border-teal-600 hover:text-teal-700"
      >
        {w.start}–{w.end} · 共 {formatMinutes(w.minutes)}
      </button>
    );
  const field = (name: "start" | "end") => (
    <input
      value={draft[name]}
      maxLength={5}
      autoFocus={name === "start"}
      aria-label={name === "start" ? "这一天几点开始" : "这一天几点结束"}
      onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      className="w-14 rounded-md border border-gray-300 bg-white px-1 py-0.5 text-center text-xs tabular-nums outline-none focus:border-teal-600"
    />
  );
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
      {field("start")}–{field("end")}
      <button onClick={commit} className="rounded-full bg-teal-700 px-2.5 py-0.5 text-white">
        保存
      </button>
      <button onClick={() => setEditing(false)} className="px-1 text-gray-500">
        取消
      </button>
      {error && <span className="text-red-600">{error}</span>}
    </span>
  );
}

// 住宿卡片：左边是竖图（172×230，3:4；比例和占卡片宽度的比例都参照 Layla 的酒店卡片）；右边从上到下是星级（没有星级就显示档次）、名字、英文名、一条横线、评分；
// 最右边是一晚的最低房价。星级、档次、英文名、房价来自高德地点详情，打开行程时按需读取（有缓存）；
// 高德没有的就不显示，房价没有时换成"查房价"，链到高德
function StayCard({ item: it }: { item: ItineraryItem }) {
  const [info, setInfo] = useState<{ id: string; place: PlaceInfo | null } | null>(null);
  useEffect(() => {
    if (!it.placeId) return;
    let cancelled = false;
    const id = it.placeId;
    prefetchPlace(id)?.then((r) => !cancelled && setInfo({ id, place: r.place }));
    return () => {
      cancelled = true;
    };
  }, [it.placeId]);
  const place = info?.id === it.placeId ? info.place : null;
  const hotel = place?.hotel ?? null;
  const rating = place?.rating ?? null;
  const amapUrl =
    it.lng !== undefined && it.lat !== undefined
      ? `https://uri.amap.com/marker?position=${it.lng},${it.lat}&name=${encodeURIComponent(it.title)}`
      : null;
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-white p-3 shadow-sm md:flex-row md:items-stretch md:gap-4">
      {it.photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- 高德图片域名不固定，不走 next/image 优化
        <img src={it.photo} alt="" referrerPolicy="no-referrer" className="h-36 w-full shrink-0 rounded-lg object-cover md:h-[230px] md:w-[172px]" />
      ) : (
        <span className="flex h-36 w-full shrink-0 items-center md:h-[230px] md:w-[172px] justify-center rounded-lg bg-gray-100 text-2xl text-gray-400">
          <HomeOutlined />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="h-5 text-sm leading-5">
          {hotel?.stars ? (
            <span className="tracking-wider text-amber-500" title={`${hotel.stars} 星级`}>
              {"★".repeat(hotel.stars)}
            </span>
          ) : hotel?.grade ? (
            <span className="text-xs text-gray-500">{hotel.grade}</span>
          ) : null}
        </div>
        <p className="mt-1 truncate text-base font-semibold text-gray-900">{it.title}</p>
        {hotel?.nameEn && <p className="truncate text-xs text-gray-500">{hotel.nameEn}</p>}
        <hr className="my-2.5 border-gray-200" />
        <p className="text-sm text-gray-700">
          {rating !== null ? (
            <>
              <span className="text-lg font-semibold text-gray-900">{rating.toFixed(1)}</span>
              <span className="ml-1 text-xs text-gray-500">高德评分</span>
            </>
          ) : (
            <span className="text-xs text-gray-400">{place ? "暂无评分" : ""}</span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-start justify-center md:items-end md:pl-2">
        {hotel?.lowestPrice ? (
          <>
            <span className="text-xl font-semibold text-gray-900">¥{hotel.lowestPrice}</span>
            <span className="text-xs text-gray-500">起 / 晚</span>
          </>
        ) : amapUrl ? (
          <a
            href={amapUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="高德没有提供房价，到高德地图里查看"
            className="rounded-full border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:border-teal-600 hover:text-teal-700"
          >
            查房价 ›
          </a>
        ) : null}
      </div>
    </div>
  );
}

// 横条卡片：景点、餐厅、住宿共用一个样式。图片 96×120（2026-11-02 用户要求放大 1.5 倍）
function PhotoCard(props: {
  photo: string | null;
  fallback: React.ReactNode;
  label?: string;
  title: string;
  detail: string;
  verified?: boolean;
  draggableHint?: boolean;
  // 开放时间对不上时的提醒
  warning?: string | null;
  // 景点和餐厅的图片：152×95（1.6:1，比例参照 Layla 的每日卡片，略大一点）；自由活动等没有照片的用小尺寸
  wide?: boolean;
}) {
  const { photo, fallback, label, title, detail, verified, draggableHint, warning, wide } = props;
  const size = wide ? "h-20 w-24 md:h-[95px] md:w-[152px]" : "h-20 w-24 md:h-24 md:w-30";
  return (
    <div className="group flex items-center gap-3 rounded-xl bg-white p-3 shadow-sm md:gap-4">
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- 高德图片域名不固定，不走 next/image 优化
        <img src={photo} alt="" draggable={false} referrerPolicy="no-referrer" className={`${size} shrink-0 rounded-lg object-cover`} />
      ) : (
        <span className={`flex ${size} shrink-0 items-center justify-center rounded-lg bg-gray-100 text-2xl text-gray-400`}>
          {fallback}
        </span>
      )}
      <span className="min-w-0 flex-1">
        {label && <span className="block text-xs text-gray-500">{label}</span>}
        <span className="block truncate text-base font-semibold text-gray-900">{title}</span>
        <span className="mt-0.5 block text-xs text-gray-500 md:truncate">{detail}</span>
        {warning && <span className="mt-1 block text-xs text-amber-700 md:truncate">⚠ {warning}</span>}
      </span>
      {verified && <span className="shrink-0 text-[11px] text-teal-700">高德</span>}
      {draggableHint && (
        <span aria-hidden className="shrink-0 select-none text-gray-300 opacity-0 transition-opacity group-hover:opacity-100">
          ⋮⋮
        </span>
      )}
    </div>
  );
}

// 卡片之间的细条：同城车程、用餐、自由活动
function Connector(props: {
  children: React.ReactNode;
  done?: boolean;
  draggable?: boolean;
  dragging?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  return (
    <div className="grid grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[48px_112px_minmax(0,1fr)] gap-x-4">
      <span />
      <span className="max-md:hidden" />
      <div
        onPointerDown={props.onPointerDown}
        className={`flex items-center gap-1.5 px-1 py-0.5 text-xs text-gray-500 ${props.done ? "opacity-50 grayscale" : ""} ${
          props.draggable ? "cursor-grab select-none rounded-md hover:bg-white/60 active:cursor-grabbing md:touch-none" : ""
        } ${props.dragging ? "bg-white shadow" : ""}`}
      >
        {props.children}
      </div>
    </div>
  );
}

// 负荷条：整条代表一天 12 小时的可活动时间，灰色是路上，青绿色是游玩；路上太久的那天整条标红
// 负荷条：总长度是这一天的活动时间段（默认 09:00–21:00），三段分别是路上、游玩、空余。
// "刚好 / 偏紧 / 太满了"按路上加游玩占总长度的比例判断，和看到的长度一致；路上时间特别长时另外标"路上久"
function LoadBar({ day: d }: { day: ItineraryDay }) {
  const window = dayWindow(d);
  const load = dayLoad(d.transitMinutes, d.playMinutes, window.minutes);
  const longRoad = transitHeavy(d.transitMinutes, window.minutes);
  const pct = (m: number) => `${Math.min(100, (m / window.minutes) * 100)}%`;
  const label = { ok: "刚好", tight: "偏紧", overloaded: "太满了" }[load];
  const tone = {
    ok: "bg-teal-50 text-teal-800",
    tight: "bg-amber-50 text-amber-800",
    overloaded: "bg-red-50 text-red-700",
  }[load];
  const road = load === "overloaded" ? "bg-red-500" : longRoad ? "bg-amber-500" : "bg-gray-500";
  const rest = load === "overloaded" ? "bg-red-100" : "bg-gray-200";
  return (
    <div className="mt-3">
      <div className={`flex h-2.5 overflow-hidden rounded-full ${rest} ${load === "overloaded" ? "ring-1 ring-red-300" : ""}`}>
        <div className={road} style={{ width: pct(d.transitMinutes) }} />
        <div className="bg-teal-500" style={{ width: pct(d.playMinutes) }} />
      </div>
      {/* 图例：三段颜色分别是路上、游玩和剩下的空余时间 */}
      <div className="mt-1 flex items-center justify-between text-[11px] text-gray-500">
        <span className="flex flex-wrap items-center gap-x-3">
          <Legend color={road}>路上 {formatMinutes(d.transitMinutes)}</Legend>
          <Legend color="bg-teal-500">游玩 {formatMinutes(d.playMinutes)}</Legend>
          <Legend color={rest}>
            空余 {formatMinutes(Math.max(0, window.minutes - d.transitMinutes - d.playMinutes))}
          </Legend>
        </span>
        <span className="flex shrink-0 gap-1">
          {longRoad && <span className="rounded-full bg-amber-50 px-1.5 text-amber-800">路上久</span>}
          <span className={`rounded-full px-1.5 ${tone}`}>{label}</span>
        </span>
      </div>
    </div>
  );
}

function Legend({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`h-2 w-2 rounded-sm ${color}`} />
      {children}
    </span>
  );
}

function endOf(x: ItineraryItem) {
  return x.start ? toClock(toMinutes(x.start) + x.minutes) : "";
}

function isLocal(x: ItineraryItem) {
  return x.kind === "transit" && (x.local ?? x.via?.startsWith("自驾") ?? false);
}

function TransportIcon({ item: it }: { item: ItineraryItem }) {
  if (/火车|高铁|动车/.test(it.via ?? "")) return <Icon component={TrainSvg} />;
  if (/飞机|航班/.test(it.via ?? "")) return <SendOutlined />;
  return <CarOutlined />;
}

// Ant Design 的图标库里没有火车，按 Ant 的线性风格补一个，通过 Ant 的 Icon 组件使用
function TrainSvg() {
  return (
    <svg
      viewBox="0 0 1024 1024"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={72}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="232" y="112" width="560" height="640" rx="120" />
      <path d="M232 448h560M392 112v336M632 112v336" />
      <circle cx="372" cy="600" r="36" fill="currentColor" stroke="none" />
      <circle cx="652" cy="600" r="36" fill="currentColor" stroke="none" />
      <path d="M352 752l-96 160M672 752l96 160" />
    </svg>
  );
}

function shortDate(iso: string) {
  const d = new Date(`${iso}T00:00:00`);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function formatDate(iso: string) {
  const d = new Date(`${iso}T00:00:00`);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${WEEKDAYS[d.getDay()]}`;
}

export function formatMinutes(m: number) {
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return h ? `${h} 小时${rest ? ` ${rest} 分` : ""}` : `${rest} 分钟`;
}
