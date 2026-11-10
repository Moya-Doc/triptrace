"use client";

import { CameraOutlined, CloseOutlined, EnvironmentOutlined, PhoneOutlined, SearchOutlined, StarFilled } from "@ant-design/icons";
import { useEffect, useState } from "react";
import { formatDistance, legMode, MODE_EMOJI, MODE_LABEL } from "@/lib/leg-format";
import { toClock, toMinutes } from "@/lib/load";
import type { ItineraryItem, LegMode } from "@/lib/types";

// 单日详情右半屏上的三个面板：改交通方式、替换候选、地点详情。都盖在地图上，地图一直挂载着

export type Place = {
  id: string;
  name: string;
  district: string;
  rating: number | null;
  photo: string | null;
  lng: number;
  lat: number;
  distanceM?: number | null;
  // 高德分类：用来判断加进来的是景点还是餐厅
  type?: string;
};

type LegOption = { mode: LegMode; minutes: number; distanceM: number | null; via: string | null };

// 地图上点了两点之间的连线：列出步行、公交地铁、打车（或自驾）各要多久，点一个就换成这种方式
export function LegPanel(props: {
  planId: number;
  dayIndex: number;
  leg: ItineraryItem;
  saving: boolean;
  onPick: (mode: LegMode) => void;
  onClose: () => void;
}) {
  const { planId, dayIndex, leg, saving, onPick, onClose } = props;
  const [state, setState] = useState<{ options: LegOption[] | null; error: string | null }>({ options: null, error: null });
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/plans/${planId}/itinerary/leg?day=${dayIndex}&title=${encodeURIComponent(leg.title)}`)
      .then((r) => r.json())
      .then((d) => !cancelled && setState({ options: d.ok ? d.options : [], error: d.ok ? null : d.error }))
      .catch(() => !cancelled && setState({ options: [], error: "连不上服务器" }));
    return () => {
      cancelled = true;
    };
  }, [planId, dayIndex, leg.title]);

  const current = legMode(leg);
  return (
    <div className="absolute inset-x-4 bottom-4 z-10 rounded-2xl bg-white p-4 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-gray-500">这一段怎么走</p>
          <p className="truncate text-sm font-semibold text-gray-900">{leg.title}</p>
          <p className="mt-0.5 text-xs text-gray-500">
            现在：{MODE_EMOJI[current]} {MODE_LABEL[current]} {leg.minutes} 分钟
            {leg.chosenBy === "user" ? "（你选的）" : "（TT 按距离和你的交通偏好选的）"}
          </p>
        </div>
        <button onClick={onClose} aria-label="关闭" className="p-1 text-gray-400 hover:text-gray-700">
          <CloseOutlined />
        </button>
      </div>
      {!state.options && <p className="mt-3 text-sm text-gray-400">正在向高德查询各种方式的时间…</p>}
      {state.error && <p className="mt-3 text-sm text-red-600">{state.error}</p>}
      <div className="mt-3 grid grid-cols-3 gap-2">
        {state.options?.map((o) => (
          <button
            key={o.mode}
            disabled={saving || o.mode === current}
            onClick={() => onPick(o.mode)}
            className={`rounded-xl border p-2.5 text-left text-xs ${
              o.mode === current ? "border-teal-600 bg-teal-50" : "border-gray-200 hover:border-teal-600"
            }`}
          >
            <span className="block text-base">{MODE_EMOJI[o.mode]}</span>
            <span className="block font-semibold text-gray-900">
              {MODE_LABEL[o.mode]} {o.minutes} 分钟
            </span>
            <span className="block truncate text-gray-500">
              {[o.mode === "transit" ? o.via : null, formatDistance(o.distanceM)].filter(Boolean).join(" · ") || "—"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// 替换：景点给 TT 的推荐（LLM 提名、高德核实），餐厅给这顿饭附近的，住宿给现在住处附近的；也可以搜索。占满右半屏
export function ReplacePanel(props: {
  planId: number;
  dayIndex: number;
  item: ItineraryItem;
  onReplace: (p: Place) => void;
  onClose: () => void;
}) {
  const { planId, dayIndex, item, onReplace, onClose } = props;
  const meal = item.kind === "free";
  const stay = item.kind === "stay";
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [result, setResult] = useState<{ key: string; items: Place[]; error: string | null }>({ key: "", items: [], error: null });
  const requestKey = `${dayIndex}|${item.title}|${submitted}`;

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ day: String(dayIndex), q: submitted });
    if (meal) params.set("meal", item.title);
    if (stay) params.set("hotel", "1");
    fetch(`/api/plans/${planId}/itinerary/suggest?${params}`)
      .then((r) => r.json())
      .then((d) => !cancelled && setResult({ key: requestKey, items: d.ok ? d.items : [], error: d.ok ? null : d.error }))
      .catch(() => !cancelled && setResult({ key: requestKey, items: [], error: "连不上服务器" }));
    return () => {
      cancelled = true;
    };
  }, [planId, dayIndex, item.title, meal, stay, submitted, requestKey]);

  const loading = result.key !== requestKey;
  const currentName = meal ? (item.venue?.name ?? item.title) : item.title;
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[#f4f3ef]">
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-6 py-4">
        <div className="min-w-0">
          <p className="text-xs text-gray-500">{meal ? `换一家${item.title}的餐厅` : stay ? "换一家住宿" : "换一个景点"}</p>
          <p className="truncate text-base font-semibold text-gray-900">替换「{currentName}」</p>
        </div>
        <button onClick={onClose} aria-label="关闭替换列表" className="rounded-full p-2 text-gray-500 hover:bg-white">
          <CloseOutlined />
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query.trim());
        }}
        className="mx-6 mt-4 flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2"
      >
        <SearchOutlined className="text-gray-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            meal ? "想吃什么？比如：火锅、川菜、小吃" : stay ? "想住哪？比如：亚朵、全季，或者春熙路" : "搜索这座城市里的地点"
          }
          className="min-w-0 flex-1 text-sm outline-none"
          autoFocus
        />
      </form>
      <p className="mx-6 mt-3 text-xs text-gray-400">
        {submitted
          ? `"${submitted}" 的搜索结果`
          : meal
            ? `${item.venue?.near ? `${item.venue.near}附近` : "附近"}的餐厅，按距离排序（高德）`
            : stay
              ? "现在住处附近 3 公里内的酒店，按距离排序（高德）"
              : "TT 的推荐（已在高德核实）"}
        {stay ? "" : "。替换后保留原来的时间"}
      </p>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 py-3">
        {loading && <p className="py-2 text-sm text-gray-400">正在查找…</p>}
        {!loading && result.error && <p className="py-2 text-sm text-red-600">{result.error}</p>}
        {!loading && !result.error && result.items.length === 0 && (
          <p className="py-2 text-sm text-gray-400">没有找到合适的地点</p>
        )}
        {!loading &&
          result.items.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded-xl bg-white p-3 shadow-sm">
              {p.photo ? (
                // eslint-disable-next-line @next/next/no-img-element -- 高德图片域名不固定，不走 next/image 优化
                <img src={p.photo} alt="" referrerPolicy="no-referrer" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
              ) : (
                <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-400">
                  <CameraOutlined />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-gray-900">{p.name}</span>
                <span className="block text-xs text-gray-500">
                  {[p.district, p.rating !== null ? `评分 ${p.rating}` : null, formatDistance(p.distanceM)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <button
                onClick={() => onReplace(p)}
                className="shrink-0 rounded-full border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:border-teal-600 hover:text-teal-700"
              >
                替换
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

export type PlaceInfo = {
  name: string;
  type: string;
  district: string;
  address: string;
  rating: number | null;
  photos: string[];
  tel: string | null;
  openTime: string | null;
  lng: number;
  lat: number;
  // 酒店才有：星级、档次（豪华型 / 舒适型…）、英文名、最低房价（高德常常没有，没有就是 null）
  hotel: { stars: number | null; grade: string | null; nameEn: string | null; lowestPrice: number | null } | null;
};

// 地点详情在浏览器里也缓存：同一个地点再次打开不用等；第一次点选卡片时就预先请求（见 prefetchPlace）
type PlaceResult = { place: PlaceInfo | null; error: string | null };
const placeCache = new Map<string, Promise<PlaceResult>>();

export function prefetchPlace(id: string | null | undefined): Promise<PlaceResult> | null {
  if (!id) return null;
  let pending = placeCache.get(id);
  if (!pending) {
    pending = fetch(`/api/place/${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d) => ({ place: d.ok ? (d.place as PlaceInfo) : null, error: d.ok ? null : (d.error as string) }))
      .catch(() => ({ place: null, error: "连不上服务器" }));
    // 失败的不缓存，下次再试
    pending.then((r) => r.error && placeCache.delete(id));
    placeCache.set(id, pending);
  }
  return pending;
}

// 地点详情：照片、地址、电话、营业时间、评分（来自高德），以及它在这一天行程里的时间。
// 名字、封面照片、行程时间是行程里已有的，先显示；地址、营业时间等从高德查到后再补上
export function PlacePanel({ item, onClose }: { item: ItineraryItem; onClose: () => void }) {
  const meal = item.kind === "free";
  const id = meal ? item.venue?.placeId : item.placeId;
  const [state, setState] = useState<PlaceResult & { id: string | null }>({ id: null, place: null, error: null });
  useEffect(() => {
    let cancelled = false;
    prefetchPlace(id)?.then((r) => !cancelled && setState({ id: id ?? null, ...r }));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const loaded = state.id === id;
  const p = loaded ? state.place : null;
  const name = meal ? (item.venue?.name ?? item.title) : item.title;
  const cover = meal ? (item.venue?.photo ?? null) : item.photo;
  const photos = p?.photos.length ? p.photos : cover ? [cover] : [];
  const end = item.start ? toClock(toMinutes(item.start) + item.minutes) : null;
  return (
    <div className="absolute inset-0 z-20 flex flex-col overflow-y-auto bg-[#f4f3ef]">
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-6 py-4">
        <p className="text-xs text-gray-500">{meal ? `餐厅 · ${item.title}` : item.kind === "stay" ? "住宿 · 今晚" : "景点"}</p>
        <button onClick={onClose} aria-label="关闭地点详情" className="rounded-full p-2 text-gray-500 hover:bg-white">
          <CloseOutlined />
        </button>
      </div>
      <div className="space-y-4 px-6 py-4">
        {photos.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {photos.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element -- 高德图片域名不固定，不走 next/image 优化
              <img
                key={src}
                src={src}
                alt=""
                referrerPolicy="no-referrer"
                className={`w-full rounded-lg object-cover ${i === 0 ? "col-span-3 h-56" : "h-24"}`}
              />
            ))}
          </div>
        )}
        <div>
          {p?.hotel?.stars ? (
            <p className="text-lg tracking-wider text-amber-500">{"★".repeat(p.hotel.stars)}</p>
          ) : p?.hotel?.grade ? (
            <p className="text-sm text-gray-500">{p.hotel.grade}</p>
          ) : null}
          <h3 className="text-2xl font-bold text-gray-900">{p?.name ?? name}</h3>
          {p?.hotel?.nameEn && <p className="text-sm text-gray-500">{p.hotel.nameEn}</p>}
          {p && (
            <p className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-gray-500">
              {p.rating !== null && (
                <span className="text-amber-600">
                  <StarFilled /> {p.rating}
                </span>
              )}
              <span>{p.type.split(";").slice(-1)[0]}</span>
              <span>{p.district}</span>
            </p>
          )}
        </div>
        {item.start && (
          <p className="rounded-xl bg-white p-3 text-sm text-gray-700">
            行程里：{item.start}–{end}，{meal ? "用餐" : "停留"} {item.minutes} 分钟
            {meal && item.venue?.why ? `。TT 选这家的理由：${item.venue.why}` : ""}
          </p>
        )}
        {!loaded && id && <p className="text-sm text-gray-400">正在从高德读取地址、营业时间和电话…</p>}
        {loaded && state.error && <p className="text-sm text-red-600">{state.error}</p>}
        {p && (
          <>
            <dl className="space-y-2 text-sm text-gray-700">
              {p.address && (
                <div className="flex gap-2">
                  <EnvironmentOutlined className="mt-1 text-gray-400" />
                  <span>{p.address}</span>
                </div>
              )}
              {p.openTime && (
                <div className="flex gap-2">
                  <span className="text-gray-400">营业</span>
                  <span>{p.openTime}</span>
                </div>
              )}
              {p.tel && (
                <div className="flex gap-2">
                  <PhoneOutlined className="mt-1 text-gray-400" />
                  <span>{p.tel}</span>
                </div>
              )}
            </dl>
            {p.hotel && (
              <p className="flex items-center gap-3 rounded-xl bg-white p-3 text-sm text-gray-700">
                {p.hotel.lowestPrice ? (
                  <>
                    <span className="text-xl font-semibold text-gray-900">¥{p.hotel.lowestPrice}</span> 起 / 晚
                  </>
                ) : (
                  <span className="text-gray-500">高德没有提供房价，可以在高德地图或订房平台查看</span>
                )}
              </p>
            )}
            <a
              href={`https://uri.amap.com/marker?position=${p.lng},${p.lat}&name=${encodeURIComponent(p.name)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-block rounded-full border border-gray-300 bg-white px-4 py-1.5 text-sm text-gray-700 hover:border-teal-600"
            >
              {p.hotel ? "在高德地图中查看房价" : "在高德地图中查看"}
            </a>
            <p className="text-xs text-gray-400">照片、地址、电话和营业时间来自高德地图</p>
          </>
        )}
      </div>
    </div>
  );
}
