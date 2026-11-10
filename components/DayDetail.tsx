"use client";

import {
  CameraOutlined,
  CoffeeOutlined,
  CompassOutlined,
  DeleteOutlined,
  HomeOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
  SearchOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { LegPanel, PlacePanel, prefetchPlace, ReplacePanel, type Place, type PlaceInfo } from "@/components/DayPanels";
import MapView, { type MapPiece, type MapSegment } from "@/components/MapView";
import PaneSwitch, { slide, useIsMobile } from "@/components/PaneSwitch";
import { legMode, legText, MODE_EMOJI, MODE_LABEL } from "@/lib/leg-format";
import { formatRanges } from "@/lib/hours";
import { isRestaurant, mealItem, mealSlot, venueOf, type MealSlot } from "@/lib/meal";
import { toClock, toMinutes } from "@/lib/load";
import type { Candidate, DayPatch, Itinerary, ItineraryItem, LegMode } from "@/lib/types";

// 单日详情（参照 Layla 的 Itinerary 页）：点时间轴上的景点或用餐打开。
// 顶部切换日期；左边是这一天的景点和用餐（餐厅），每一项前面是开始和结束时间，可以直接改；可以删除、添加景点；
// 右边是这一天的地图，按顺序用弧线连起来。
// 明显矛盾的时间（早于上一项结束、晚于下一项固定的开始、跨过午夜）不接受：时间框标红、下方说明原因，按 Esc 恢复原来的时间。
// 其余修改都交给服务端重新计算车程、时间和负荷


type Props = {
  planId: number;
  itinerary: Itinerary;
  dayIndex: number;
  selectedTitle: string | null;
  onBack: () => void;
  onChangeDay: (index: number) => void;
  // label：这次修改做了什么（撤销时显示）；null 表示系统自己的整理，不进撤销历史
  // patch：顺带换住宿（来自"替换"的酒店候选）
  onSave: (
    dayIndex: number,
    order: ItineraryItem[],
    legs?: Record<string, LegMode>,
    label?: string | null,
    patch?: DayPatch,
  ) => Promise<void>;
};

// 右半屏：默认是地图；点"替换"后是候选列表；再次点击已选中的景点或餐厅，是这个地点的详情。地图一直挂载在下面
type Panel = { kind: "replace"; item: ItineraryItem } | { kind: "place"; item: ItineraryItem } | null;

export default function DayDetail(props: Props) {
  const { planId, itinerary, dayIndex, onBack, onChangeDay, onSave } = props;
  const day = itinerary.days.find((d) => d.index === dayIndex)!;
  const [saving, setSaving] = useState(false);
  const [pane, setPane] = useState<"list" | "map">("list");
  const isMobile = useIsMobile();
  // 正在添加：景点 / 用餐（两个入口，候选列表不同）
  const [adding, setAdding] = useState<"place" | "meal" | null>(null);
  // 加的是餐厅、而这一天已经有这顿饭：先问替换原来的，还是额外加一站
  const [mealChoice, setMealChoice] = useState<{ place: Place; slot: MealSlot; at: number; existing: ItineraryItem } | null>(null);
  const [selected, setSelected] = useState<string | null>(props.selectedTitle);
  // 添加景点时的候选地点：同时标在地图上（橙色图钉），列表和图钉可以互相点选，方便判断位置
  const [suggestions, setSuggestions] = useState<Place[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  // 地图上点中的那一段路（标题"A → B"）
  const [activeLeg, setActiveLeg] = useState<string | null>(null);
  // 从时间轴点进来时，那一项已经是选中状态：打开详情时就预先请求它的地点详情
  useEffect(() => {
    const first = day.items.find((x) => x.title === props.selectedTitle);
    if (first) prefetchPlace(first.kind === "free" ? first.venue?.placeId : first.placeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时预取一次
  }, []);

  // 每段路的真实路径：打开详情时按需查询；交通段或交通方式变了（key 变了）就重新查
  const legsKey = day.items
    .filter((x) => x.kind === "transit" && x.local)
    .map((x) => `${x.title}|${x.mode ?? "drive"}`)
    .join(";");
  const [paths, setPaths] = useState<{ key: string; byLeg: Record<string, MapPiece[]> }>({ key: "", byLeg: {} });
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/plans/${planId}/itinerary/paths?day=${dayIndex}`)
      .then((r) => r.json())
      .then((d) => !cancelled && d.ok && setPaths({ key: `${dayIndex}#${legsKey}`, byLeg: d.paths }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [planId, dayIndex, legsKey]);
  const byLeg = paths.key === `${dayIndex}#${legsKey}` ? paths.byLeg : null;

  // 早期生成的行程：交通段没有记录交通方式和坐标，用餐也可能还没有餐厅，景点没有开放时间。
  // 打开这一天的详情时自动重新排一次（每天只做一次），补上交通方式、路线、餐厅和开放时间
  const upgraded = useRef(new Set<number>());
  const legacy = day.items.some(
    (x) =>
      (x.kind === "transit" && (x.local ?? x.via?.startsWith("自驾")) && (!x.mode || !x.endpoints)) ||
      (x.kind === "free" && /餐/.test(x.title) && !x.venue) ||
      (x.kind === "place" && Boolean(x.placeId) && x.hours === undefined),
  );
  useEffect(() => {
    if (!legacy || upgraded.current.has(dayIndex)) return;
    upgraded.current.add(dayIndex);
    setSaving(true);
    onSave(
      dayIndex,
      day.items.filter((x) => x.kind === "place" || x.kind === "free"),
      undefined,
      null,
    ).finally(() => setSaving(false));
  }, [legacy, dayIndex, day.items, onSave]);

  // 景点和用餐：保存时要按原顺序整体提交
  const core = day.items.filter((x) => x.kind === "place" || x.kind === "free");
  const places = core.filter((x) => x.kind === "place");
  // 详情里按顺序显示的条目：景点、用餐，以及它们之间的同城交通（不含城际交通和住宿）
  const stay = day.items.find((x) => x.kind === "stay");
  // 去住处的那一段路放到最下面，紧挨着住宿卡片（在添加按钮下方）
  const hotelLeg = stay ? day.items.find((x) => x.kind === "transit" && x.local && x.title.endsWith(` → ${stay.title}`)) : undefined;
  const sequence = day.items.filter(
    (x) => (x.kind === "place" || x.kind === "free" || (x.kind === "transit" && x.local)) && x !== hotelLeg,
  );
  const limits = limitsOf(sequence);

  async function save(order: ItineraryItem[], label: string, legs?: Record<string, LegMode>) {
    setSaving(true);
    await onSave(dayIndex, order, legs, label);
    setSaving(false);
  }

  function changeTime(item: ItineraryItem, time: string) {
    if (!/^\d{2}:\d{2}$/.test(time) || time === item.start) return;
    save(core.map((x) => (x === item ? { ...x, start: time, pinned: true } : x)), `「${nameOf(item)}」改为 ${time} 开始`);
  }

  // 改结束时间 = 改停留时长。开始时间也一起固定下来，否则重新查路线后开始时间可能浮动一两分钟，结束时间就对不上了
  function changeEnd(item: ItineraryItem, end: string) {
    if (!item.start || !/^\d{2}:\d{2}$/.test(end)) return;
    const minutes = toMinutes(end) - toMinutes(item.start);
    if (minutes < 10 || minutes === item.minutes) return;
    save(core.map((x) => (x === item ? { ...x, minutes, pinned: true } : x)), `「${nameOf(item)}」改为 ${end} 结束`);
  }

  function remove(item: ItineraryItem) {
    if (panel?.item === item) setPanel(null);
    save(core.filter((x) => x !== item), `删除「${nameOf(item)}」`);
  }

  // 替换：景点换成另一个地点，保留原来的开始时间和停留时长；用餐只换餐厅；住宿换一家酒店
  function replace(item: ItineraryItem, p: Place) {
    if (item.kind === "stay") {
      setPanel(null);
      setSelected(p.name);
      setSaving(true);
      onSave(dayIndex, core, undefined, `住宿换成「${p.name}」`, {
        stay: { id: p.id, name: p.name, photo: p.photo, lng: p.lng, lat: p.lat, district: p.district },
      }).finally(() => setSaving(false));
      return;
    }
    const next: ItineraryItem =
      item.kind === "free"
        ? {
            ...item,
            venue: {
              name: p.name,
              placeId: p.id,
              photo: p.photo,
              lng: p.lng,
              lat: p.lat,
              distanceM: p.distanceM ?? null,
              near: item.venue?.near ?? null,
              why: null,
            },
          }
        : {
            kind: "place",
            title: p.name,
            start: item.start,
            pinned: item.pinned,
            minutes: item.minutes,
            via: null,
            placeId: p.id,
            photo: p.photo,
            verified: false,
            lng: p.lng,
            lat: p.lat,
          };
    setPanel(null);
    setSelected(next.title);
    save(core.map((x) => (x === item ? next : x)), `「${nameOf(item)}」换成「${p.name}」`);
  }

  // 新加的放在当天最后一个景点后面。高德分类是餐厅的，作为一顿饭加进来（见 lib/meal.ts）
  function add(p: Place) {
    const lastPlace = core.map((x) => x.kind).lastIndexOf("place");
    const at = lastPlace + 1;
    const order = [...core];
    if (isRestaurant(p.type)) {
      const slot = mealSlot(core, at);
      const existing = core.find((x) => x.kind === "free" && x.title === slot);
      if (existing) {
        setMealChoice({ place: p, slot, at, existing });
        return;
      }
      order.splice(at, 0, mealItem(slot, p));
      closeAdding();
      save(order, `添加${slot}「${p.name}」`);
      return;
    }
    order.splice(at, 0, {
      kind: "place",
      title: p.name,
      start: null,
      minutes: 120,
      via: null,
      placeId: p.id,
      photo: p.photo,
      verified: false,
      lng: p.lng,
      lat: p.lat,
    });
    closeAdding();
    save(order, `添加「${p.name}」`);
  }

  // 回答"替换原来的午餐，还是额外加一站"
  function resolveMeal(choice: "replace" | "extra") {
    if (!mealChoice) return;
    const { place, at, existing } = mealChoice;
    const order =
      choice === "replace"
        ? core.map((x) => (x === existing ? { ...x, venue: venueOf(place) } : x))
        : [...core.slice(0, at), mealItem("加餐", place), ...core.slice(at)];
    setMealChoice(null);
    closeAdding();
    save(order, choice === "replace" ? `${mealChoice.slot}换成「${place.name}」` : `加一站「${place.name}」`);
  }

  function closeAdding() {
    setAdding(null);
    setMealChoice(null);
    setSuggestions([]);
    setPicked(null);
  }

  function pick(id: string | null) {
    setPicked(id);
    setSelected(null);
  }

  // 点卡片：第一次选中（地图上高亮这个地点），再点一次打开地点详情。手机上看不到高亮，点一次就打开
  function clickItem(it: ItineraryItem) {
    setPicked(null);
    setActiveLeg(null);
    if ((isMobile || selected === it.title) && (it.placeId || it.venue)) {
      setSelected(it.title);
      setPanel({ kind: "place", item: it });
    } else {
      setSelected(it.title);
      // 第一次点选时就预先请求地点详情，再点一次打开时通常已经拿到了
      prefetchPlace(it.kind === "free" ? it.venue?.placeId : it.placeId);
    }
  }

  // 地图上的图钉：这一天的景点（青绿、按顺序编号）、餐厅（琥珀色"餐"）、住宿（灰色"住"）和待添加的候选地点（橙色"+"）。
  // 图钉 id 用"item:条目名"，和列表里的选中状态对应。
  // 连线：按顺序连起相邻的两个点；这两点之间有交通段的，线上标出交通方式，点击可以改。
  // 记住结果，避免每次点选都让地图重新调整视野
  const { pins, segments } = useMemo(() => {
    const items = itinerary.days.find((d) => d.index === dayIndex)?.items ?? [];
    // 景点按顺序编号，餐厅和住宿用"餐""住"，不占编号
    let n = 0;
    const own: Candidate[] = [];
    for (const x of items) {
      if ((x.kind === "place" || x.kind === "stay") && x.lng !== undefined && x.lat !== undefined) {
        own.push({
          ...pin(`item:${x.title}`, x.title, x.lng, x.lat, x.photo, x.kind === "stay" ? 99 : ++n),
          ...(x.kind === "stay" ? { color: "#6b7280", badge: "住" } : {}),
        });
      } else if (x.kind === "free" && x.venue) {
        own.push({
          ...pin(`item:${x.title}`, x.venue.name, x.venue.lng, x.venue.lat, x.venue.photo, 99),
          color: "#d97706",
          badge: "餐",
        });
      }
    }
    const extra = suggestions.map((p, i) => ({
      ...pin(`sug:${p.id}`, p.name, p.lng, p.lat, p.photo, 100 + i),
      color: "#ea580c",
      badge: "+",
    }));
    const legs = items.filter((x) => x.kind === "transit" && x.local);
    const segs: MapSegment[] = [];
    for (let i = 1; i < own.length; i++) {
      const a = own[i - 1];
      const b = own[i];
      const leg = legs.find((x) => x.title === `${a.name} → ${b.name}`);
      segs.push({
        key: leg?.title ?? `${a.id}|${b.id}`,
        from: { name: a.name, lng: a.lng, lat: a.lat },
        to: { name: b.name, lng: b.lng, lat: b.lat },
        label: leg?.endpoints ? `${MODE_EMOJI[legMode(leg)]} ${leg.minutes} 分钟` : null,
        pieces: leg ? byLeg?.[leg.title] : undefined,
      });
    }
    return { pins: [...own, ...extra], segments: segs };
  }, [itinerary, dayIndex, suggestions, byLeg]);
  const selectedPin = picked ? `sug:${picked}` : selected ? `item:${selected}` : null;
  const leg = activeLeg ? day.items.find((x) => x.kind === "transit" && x.title === activeLeg) : undefined;

  // 路段、替换、地点详情三个面板：宽屏盖在地图那一边；手机上地图可能在屏幕外，直接盖在当前屏幕上
  const panels = (
    <>
      {leg && (
        <LegPanel
          key={leg.title}
          planId={planId}
          dayIndex={dayIndex}
          leg={leg}
          saving={saving}
          onPick={(mode) => save(core, `「${leg.title}」改为${MODE_LABEL[mode]}`, { [leg.title]: mode })}
          onClose={() => setActiveLeg(null)}
        />
      )}
      {/* data-full-panel：外面的"撤销"按钮看到它就先藏起来，免得盖住面板的关闭按钮 */}
      {panel && (
        <div data-full-panel className="contents">
          {panel.kind === "replace" ? (
            <ReplacePanel
              key={panel.item.title}
              planId={planId}
              dayIndex={dayIndex}
              item={panel.item}
              onReplace={(p) => replace(panel.item, p)}
              onClose={() => setPanel(null)}
            />
          ) : (
            <PlacePanel key={panel.item.title} item={panel.item} onClose={() => setPanel(null)} />
          )}
        </div>
      )}
    </>
  );

  return (
    // 左右分栏：左边是日期和景点列表（自己滚动），右边是占满整个高度的地图，中间一条分割线
    <div className="relative flex h-full flex-col overflow-clip bg-[#f4f3ef] xl:flex-row">
      {/* 手机上一次只看一边：安排 / 地图 */}
      {!panel && !leg && (
        <div className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full bg-white shadow-md md:hidden">
          <PaneSwitch
            value={pane}
            onChange={setPane}
            options={[
              { key: "list", label: "安排" },
              { key: "map", label: "地图" },
            ]}
          />
        </div>
      )}
      <div
        inert={isMobile && pane !== "list"}
        className={`flex min-h-0 min-w-0 flex-1 flex-col max-md:absolute max-md:inset-0 max-md:bg-[#f4f3ef] xl:w-1/2 xl:flex-none ${slide("left", pane === "list")}`}
      >
        <div className="space-y-4 px-4 pt-4 md:px-6 md:pt-6">
          <div className="flex items-center gap-3 text-sm">
            <button
              onClick={onBack}
              aria-label="返回行程"
              className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-gray-300 bg-white text-gray-600 hover:border-gray-500"
            >
              <LeftOutlined />
            </button>
            <span className="text-gray-500">行程</span>
            <RightOutlined className="text-[10px] text-gray-400" />
            <span className="font-semibold text-gray-900">第 {dayIndex + 1} 天</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onChangeDay(Math.max(0, dayIndex - 1))}
              disabled={dayIndex === 0}
              aria-label="前一天"
              className="p-2 text-gray-500 disabled:opacity-30"
            >
              <LeftOutlined />
            </button>
            <div className="flex flex-1 gap-1 overflow-x-auto">
              {itinerary.days.map((d) => (
                <button
                  key={d.index}
                  onClick={() => onChangeDay(d.index)}
                  className={`shrink-0 rounded-full px-4 py-1.5 text-sm ${
                    d.index === dayIndex ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-white"
                  }`}
                >
                  {d.date ? shortDate(d.date) : `第 ${d.index + 1} 天`}
                </button>
              ))}
            </div>
            <button
              onClick={() => onChangeDay(Math.min(itinerary.days.length - 1, dayIndex + 1))}
              disabled={dayIndex === itinerary.days.length - 1}
              aria-label="后一天"
              className="p-2 text-gray-500 disabled:opacity-30"
            >
              <RightOutlined />
            </button>
          </div>

          <p className="text-sm text-gray-600">
            <span className="font-semibold text-gray-900">{day.date ? shortDate(day.date) : ""}</span> · {day.city} ·{" "}
            {places.length} 个景点
            {saving && <span className="ml-3 text-xs text-gray-400">正在重新排时间…</span>}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-16 pt-4 md:px-6 md:pb-6">
          <div className={`space-y-3 ${saving ? "opacity-60" : ""}`}>
            {/* 按时间顺序：景点和用餐的卡片，以及它们之间的交通，方便看清每一段从几点到几点 */}
            {sequence.map((it, i) =>
              it.kind === "transit" ? (
                <Gap
                  key={`g${i}`}
                  item={it}
                  active={activeLeg === it.title}
                  onClick={() => {
                    setPanel(null);
                    setActiveLeg(it.title);
                  }}
                />
              ) : (
                <ItemRow
                  key={`${it.kind}:${it.placeId ?? it.title}`}
                  item={it}
                  limit={limits.get(it) ?? null}
                  selected={selected === it.title}
                  replacing={panel?.kind === "replace" && panel.item === it}
                  saving={saving}
                  onSelect={() => clickItem(it)}
                  onStart={(t) => changeTime(it, t)}
                  onEnd={(t) => changeEnd(it, t)}
                  onUnpin={() =>
                    save(core.map((x) => (x === it ? { ...x, pinned: false } : x)), `「${nameOf(it)}」按路上时间顺延`)
                  }
                  onReplace={() => {
                    setActiveLeg(null);
                    setSelected(it.title);
                    setPanel({ kind: "replace", item: it });
                  }}
                  onRemove={() => remove(it)}
                />
              ),
            )}

            {mealChoice && (
              <div className="ml-[84px] space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <p>
                  这一天已经有{mealChoice.slot}（{mealChoice.existing.venue?.name ?? mealChoice.existing.title}）。
                  「{mealChoice.place.name}」是替换原来的{mealChoice.slot}，还是额外加一站？
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => resolveMeal("replace")}
                    className="rounded-full bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700"
                  >
                    替换原来的{mealChoice.slot}
                  </button>
                  <button
                    onClick={() => resolveMeal("extra")}
                    className="rounded-full border border-amber-400 bg-white px-3 py-1 text-xs hover:border-amber-600"
                  >
                    额外加一站
                  </button>
                  <button onClick={() => setMealChoice(null)} className="px-2 py-1 text-xs text-amber-700">
                    取消
                  </button>
                </div>
              </div>
            )}

            {adding ? (
              <AddPanel
                key={adding}
                mode={adding}
                planId={planId}
                dayIndex={dayIndex}
                picked={picked}
                onPick={pick}
                onResults={(items) => {
                  setSuggestions(items);
                  setPicked(null);
                }}
                onAdd={add}
                onClose={closeAdding}
              />
            ) : (
              // 两个入口：景点给 TT 的推荐，用餐给这一天最后一个地点附近的餐厅
              <div className="ml-[84px] grid grid-cols-2 gap-3">
                <button
                  onClick={() => setAdding("place")}
                  disabled={saving}
                  className="flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 py-3 text-sm font-medium text-gray-700 hover:border-gray-500"
                >
                  <PlusOutlined /> 景点
                </button>
                <button
                  onClick={() => setAdding("meal")}
                  disabled={saving}
                  className="flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 py-3 text-sm font-medium text-gray-700 hover:border-gray-500"
                >
                  <PlusOutlined /> 用餐
                </button>
              </div>
            )}

            {/* 当天的住宿：在最下面（添加按钮下方），前面是走过去的那一段路 */}
            {hotelLeg && (
              <Gap
                item={hotelLeg}
                active={activeLeg === hotelLeg.title}
                onClick={() => {
                  setPanel(null);
                  setActiveLeg(hotelLeg.title);
                }}
              />
            )}
            {stay && (
              <HotelRow
                item={stay}
                selected={selected === stay.title}
                replacing={panel?.kind === "replace" && panel.item === stay}
                saving={saving}
                onSelect={() => clickItem(stay)}
                onReplace={() => {
                  setActiveLeg(null);
                  setSelected(stay.title);
                  setPanel({ kind: "replace", item: stay });
                }}
              />
            )}
          </div>
        </div>
      </div>

      <div
        inert={isMobile && pane !== "map"}
        className={`relative h-[45%] w-full shrink-0 border-t-2 border-gray-200 max-md:absolute max-md:inset-0 max-md:h-full max-md:border-t-0 xl:h-full xl:w-1/2 xl:border-l-2 xl:border-t-0 ${slide("right", pane === "map")}`}
      >
        <MapView
          anchor={null}
          candidates={pins}
          route={null}
          selectedId={selectedPin}
          shortlistIds={[]}
          onSelect={(id) => {
            setActiveLeg(null);
            if (id.startsWith("sug:")) pick(id.slice(4));
            else {
              setPicked(null);
              setSelected(id.replace(/^item:/, ""));
            }
          }}
          onMapClick={() => {
            setSelected(null);
            setPicked(null);
            setActiveLeg(null);
          }}
          followSelected
          maxZoom={17}
          segments={segments}
          activeSegment={activeLeg}
          onSegmentClick={(key) => {
            setSelected(null);
            setActiveLeg(key);
          }}
          dropZoneHeight={0}
          onDragOverDropZone={() => {}}
          onDropToShortlist={() => {}}
        />
        {!isMobile && panels}
      </div>
      {isMobile && panels}
    </div>
  );
}

// 每一项能接受的时间范围：不能早于上一项结束（加上中间的车程），
// 如果下一项的开始时间是用户固定的，也不能晚于它（减去中间的车程）
type Limit = { earliest: number | null; prevTitle: string | null; latest: number | null; nextTitle: string | null };

function limitsOf(sequence: ItineraryItem[]) {
  const timed: { item: ItineraryItem; gapBefore: number }[] = [];
  let gap = 0;
  for (const x of sequence) {
    if (x.kind === "transit") gap += x.minutes;
    else {
      timed.push({ item: x, gapBefore: gap });
      gap = 0;
    }
  }
  const out = new Map<ItineraryItem, Limit>();
  timed.forEach(({ item, gapBefore }, k) => {
    const prev = timed[k - 1]?.item;
    const next = timed[k + 1];
    out.set(item, {
      earliest: prev?.start ? toMinutes(prev.start) + prev.minutes + gapBefore : null,
      prevTitle: prev ? label(prev) : null,
      latest: next?.item.pinned && next.item.start ? toMinutes(next.item.start) - next.gapBefore : null,
      nextTitle: next ? label(next.item) : null,
    });
  });
  return out;
}

function label(x: ItineraryItem) {
  return x.venue ? `${x.title}（${x.venue.name}）` : x.title;
}

// 允许"930""9:30""9：30"这类写法，统一成 09:30；认不出来返回 null
function normalizeClock(text: string) {
  const m = text.trim().match(/^(\d{1,2})[:：.]?(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
}

// 一项（景点或用餐）：左边是开始 / 结束时间，右边是卡片
function ItemRow(props: {
  item: ItineraryItem;
  limit: Limit | null;
  selected: boolean;
  replacing: boolean;
  saving: boolean;
  onSelect: () => void;
  onReplace: () => void;
  // 时间冲突时：取消这一项的固定时间，按上一项结束 + 路上时间顺延
  onUnpin: () => void;
  onStart: (t: string) => void;
  onEnd: (t: string) => void;
  onRemove: () => void;
}) {
  const { item: it, limit, selected, saving } = props;
  const meal = it.kind === "free" && /餐/.test(it.title);
  const start = it.start ?? "";
  const end = endOf(it) ?? "";
  const [draft, setDraft] = useState({ start, end });
  const [error, setError] = useState<string | null>(null);
  // 按 Esc 恢复后紧接着的失去焦点不再提交
  const reverting = useRef(false);
  const [prev, setPrev] = useState({ start, end });
  if (prev.start !== start || prev.end !== end) {
    setPrev({ start, end });
    setDraft({ start, end });
    setError(null);
  }

  // 检查新时间是否矛盾；矛盾就不提交，只提示
  function check(field: "start" | "end", value: string): string | null {
    const t = normalizeClock(value);
    if (!t) return "时间的格式是 时:分，例如 09:30";
    const s = field === "start" ? toMinutes(t) : toMinutes(start);
    const e = field === "start" ? s + it.minutes : toMinutes(t);
    if (field === "start" && limit?.earliest != null && s < limit.earliest)
      return `开始时间早于上一项结束：${limit.prevTitle} 到 ${toClock(limit.earliest)} 才结束（含路上时间）`;
    if (field === "end" && e < s + 10) return `结束时间要晚于开始时间 ${toClock(s)}`;
    if (e >= 24 * 60) return "结束时间跨过了午夜";
    if (limit?.latest != null && e > limit.latest)
      return `会和下一项冲突：${limit.nextTitle} 固定在 ${toClock(limit.latest)} 之后（含路上时间）开始`;
    return null;
  }

  function commit(field: "start" | "end") {
    if (reverting.current) {
      reverting.current = false;
      return;
    }
    const value = draft[field];
    if (value === (field === "start" ? start : end)) {
      setError(null);
      return;
    }
    const problem = check(field, value);
    setError(problem);
    if (problem) return;
    const t = normalizeClock(value)!;
    if (field === "start") props.onStart(t);
    else props.onEnd(t);
  }

  // Esc：放弃这次修改，恢复原来的时间
  function revert(e: React.KeyboardEvent<HTMLInputElement>) {
    setDraft({ start, end });
    setError(null);
    reverting.current = true;
    e.currentTarget.blur();
  }

  const bad = Boolean(error) || Boolean(it.conflict);
  const field = (name: "start" | "end") => (
    <input
      value={draft[name]}
      inputMode="numeric"
      maxLength={5}
      placeholder="--:--"
      aria-label={name === "start" ? "开始时间" : "结束时间"}
      onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}
      onBlur={() => commit(name)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") revert(e);
      }}
      className="w-full rounded-md bg-white py-1 text-center text-sm tabular-nums text-gray-800 outline-none focus:bg-teal-50"
    />
  );

  return (
    <div>
      <div className="flex items-center gap-3">
        <div
          className={`flex w-[72px] shrink-0 flex-col items-stretch gap-0.5 rounded-lg border bg-white p-1 ${
            bad ? "border-red-400 ring-2 ring-red-300" : "border-gray-200"
          }`}
        >
          {field("start")}
          <span className="text-center text-[10px] leading-none text-gray-400">至</span>
          {field("end")}
        </div>
        <div
          onClick={props.onSelect}
          className={`flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl bg-white p-3 shadow-sm ${
            selected ? (meal ? "ring-2 ring-amber-500" : "ring-2 ring-teal-600") : ""
          }`}
        >
          {(meal ? it.venue?.photo : it.photo) ? (
            // eslint-disable-next-line @next/next/no-img-element -- 高德图片域名不固定，不走 next/image 优化
            <img
              src={(meal ? it.venue?.photo : it.photo)!}
              alt=""
              referrerPolicy="no-referrer"
              className="h-16 w-16 shrink-0 rounded-lg object-cover"
            />
          ) : (
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-400">
              {meal ? <CoffeeOutlined /> : it.kind === "free" ? <CompassOutlined /> : <CameraOutlined />}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 text-xs text-gray-500">
              {meal ? (
                <>
                  <CoffeeOutlined /> 餐厅 · {it.title}
                </>
              ) : it.kind === "free" ? (
                <>
                  <CompassOutlined /> 活动
                </>
              ) : (
                <>
                  <CameraOutlined /> 景点
                </>
              )}
            </span>
            <span className="block truncate text-base font-semibold text-gray-900">
              {meal ? (it.venue?.name ?? "附近找家馆子") : it.title}
            </span>
            <span className={`block truncate text-xs ${it.conflict ? "text-red-600" : "text-gray-500"}`}>
              {it.conflict
                ? "和前一项时间重叠了"
                : [
                    `${meal ? "用餐" : "停留"} ${formatMinutes(it.minutes)}，到 ${end || "—"}`,
                    it.hours?.ranges ? `${meal ? "营业" : "开放"} ${formatRanges(it.hours)}` : "",
                    meal && it.venue?.why ? it.venue.why : "",
                    meal && !it.venue?.why && it.venue?.near && it.venue.distanceM !== null
                      ? `离${it.venue.near}约 ${it.venue.distanceM} 米`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </span>
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              props.onReplace();
            }}
            disabled={saving}
            aria-label={`替换 ${it.title}`}
            title={meal ? "换一家餐厅" : "换一个景点"}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${
              props.replacing ? "border-teal-600 text-teal-700" : "border-gray-200 text-gray-500"
            } hover:border-teal-600 hover:text-teal-700`}
          >
            <SwapOutlined />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              props.onRemove();
            }}
            disabled={saving}
            aria-label={`删除 ${it.title}`}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-gray-200 text-gray-500 hover:border-red-300 hover:text-red-600"
          >
            <DeleteOutlined />
          </button>
        </div>
      </div>
      {it.hoursIssue && (
        <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs leading-5 text-amber-800">
          ⚠ {it.hoursIssue}
          {it.hours?.text ? `（高德：${it.hours.text}）` : ""}
        </p>
      )}
      {it.conflict && it.pinned && !error && (
        <p className="mt-1.5 flex items-center gap-2 text-xs text-red-600">
          这一项固定在 {start}，但上一项结束后走过来要更晚。
          <button
            onClick={props.onUnpin}
            disabled={saving}
            className="rounded-full border border-red-300 bg-white px-2.5 py-0.5 text-red-700 hover:border-red-500"
          >
            按路上时间顺延
          </button>
        </p>
      )}
      {error && (
        <p className="mt-1.5 text-xs leading-5 text-red-600">
          {error}。这次修改没有保存，按 Esc 恢复原来的时间
        </p>
      )}
    </div>
  );
}

// 添加景点：不输入关键词时显示 TT 的推荐（LLM 提名、高德核实），输入关键词则在这座城市里搜索
function AddPanel(props: {
  mode: "place" | "meal";
  planId: number;
  dayIndex: number;
  picked: string | null;
  onPick: (id: string) => void;
  onResults: (items: Place[]) => void;
  onAdd: (p: Place) => void;
  onClose: () => void;
}) {
  const { mode, planId, dayIndex, picked, onPick, onAdd, onClose } = props;
  // 回调放进 ref：请求的 effect 里总能拿到最新版本，又不会因此重新请求
  const onResultsRef = useRef(props.onResults);
  useEffect(() => {
    onResultsRef.current = props.onResults;
  });
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [result, setResult] = useState<{
    key: string;
    items: Place[] | null;
    error: string | null;
  }>({
    key: "",
    items: null,
    error: null,
  });
  const requestKey = `${dayIndex}|${submitted}`;

  useEffect(() => {
    let cancelled = false;
    fetch(
      `/api/plans/${planId}/itinerary/suggest?day=${dayIndex}&q=${encodeURIComponent(submitted)}${mode === "meal" ? "&food=1" : ""}`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setResult({
          key: requestKey,
          items: d.ok ? d.items : [],
          error: d.ok ? null : d.error,
        });
        onResultsRef.current(d.ok ? d.items : []);
      })
      .catch(
        () =>
          !cancelled &&
          setResult({ key: requestKey, items: [], error: "连不上服务器" }),
      );
    return () => {
      cancelled = true;
    };
  }, [planId, dayIndex, submitted, requestKey, mode]);

  const loading = result.key !== requestKey;
  return (
    <div className="ml-[84px] space-y-2 rounded-xl border border-gray-200 bg-white p-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query.trim());
        }}
        className="flex items-center gap-2"
      >
        <SearchOutlined className="text-gray-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === "meal" ? "想吃什么？比如：火锅、川菜，或直接从附近的餐厅里选" : "搜索这座城市里的地点，或直接从推荐里选"}
          className="min-w-0 flex-1 text-sm outline-none"
          autoFocus
        />
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-gray-500 hover:text-gray-900"
        >
          收起
        </button>
      </form>
      <div className="text-xs text-gray-400">
        {submitted
          ? `"${submitted}" 的搜索结果`
          : mode === "meal"
            ? "这一天最后一个地点附近的餐厅（高德）"
            : "TT 的推荐（已在高德核实）"}
        {"，对应地图上的橙色图钉，点列表或图钉可以互相定位"}
      </div>
      {loading && <p className="py-2 text-sm text-gray-400">正在查找…</p>}
      {!loading && result.error && (
        <p className="py-2 text-sm text-red-600">{result.error}</p>
      )}
      {!loading && result.items?.length === 0 && (
        <p className="py-2 text-sm text-gray-400">没有找到合适的地点</p>
      )}
      {!loading &&
        result.items?.map((p) => (
          <SuggestionRow key={p.id} active={picked === p.id} onClick={() => onPick(p.id)}>
            {p.photo ? (
              // eslint-disable-next-line @next/next/no-img-element -- 高德图片域名不固定，不走 next/image 优化
              <img
                src={p.photo}
                alt=""
                referrerPolicy="no-referrer"
                className="h-10 w-10 shrink-0 rounded-md object-cover"
              />
            ) : (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-400">
                <CameraOutlined />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-gray-900">
                {p.name}
              </span>
              <span className="block text-xs text-gray-500">
                {p.district}
                {p.rating !== null && ` · 评分 ${p.rating}`}
              </span>
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAdd(p);
              }}
              className="shrink-0 rounded-full border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:border-teal-600 hover:text-teal-700"
            >
              添加
            </button>
          </SuggestionRow>
        ))}
    </div>
  );
}

// 候选地点的一行：在地图上点了它的图钉时高亮，并滚动到看得见的位置
function SuggestionRow(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [props.active]);
  return (
    <div
      ref={ref}
      onClick={props.onClick}
      className={`flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 ${
        props.active ? "bg-orange-50 ring-2 ring-orange-500" : "hover:bg-gray-50"
      }`}
    >
      {props.children}
    </div>
  );
}

function pin(
  id: string,
  name: string,
  lng: number,
  lat: number,
  photo: string | null,
  rank: number,
): Candidate {
  return {
    rank,
    id,
    name,
    district: "",
    address: "",
    lng,
    lat,
    photo,
    rating: null,
    driveMinutes: null,
    distanceKm: null,
    checks: [],
    score: 0,
    maxScore: 0,
  };
}

// 两项之间的细条：交通方式、多久、多远。点一下在地图上选中这一段，可以改交通方式
function Gap({ item, active, onClick }: { item: ItineraryItem; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`ml-[84px] flex items-center gap-2 rounded-full px-2 py-0.5 text-left text-xs ${
        active ? "bg-amber-50 text-amber-800 ring-1 ring-amber-400" : "text-gray-500 hover:bg-white"
      }`}
    >
      <span aria-hidden>{MODE_EMOJI[legMode(item)]}</span>
      {legText(item)}
      {item.verified && <span className="text-teal-700">高德</span>}
      {item.chosenBy === "user" && <span className="text-gray-400">你选的</span>}
    </button>
  );
}

// 住宿卡片：左边是"今晚住"，右边是照片、星级或档次、名字、评分；可以替换，点两下打开酒店详情
function HotelRow(props: {
  item: ItineraryItem;
  selected: boolean;
  replacing: boolean;
  saving: boolean;
  onSelect: () => void;
  onReplace: () => void;
}) {
  const { item: it, selected, replacing, saving } = props;
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
  return (
    <div className="flex items-center gap-3">
      <div className="flex w-[72px] shrink-0 flex-col items-center justify-center rounded-lg border border-gray-200 bg-white py-2 text-xs text-gray-500">
        <HomeOutlined className="text-base" />
        <span className="mt-1">今晚住</span>
      </div>
      <div
        onClick={props.onSelect}
        className={`flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl bg-white p-3 shadow-sm ${
          selected ? "ring-2 ring-gray-500" : ""
        }`}
      >
        {it.photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- 高德图片域名不固定，不走 next/image 优化
          <img src={it.photo} alt="" referrerPolicy="no-referrer" className="h-20 w-16 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="flex h-20 w-16 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-400">
            <HomeOutlined />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-gray-500">
            住宿
            {hotel?.stars ? (
              <span className="ml-1.5 tracking-wider text-amber-500">{"★".repeat(hotel.stars)}</span>
            ) : hotel?.grade ? (
              ` · ${hotel.grade}`
            ) : (
              ""
            )}
          </span>
          <span className="block truncate text-base font-semibold text-gray-900">{it.title}</span>
          <span className="block truncate text-xs text-gray-500">
            {[place?.rating != null ? `高德评分 ${place.rating}` : "", it.via ?? ""].filter(Boolean).join(" · ")}
          </span>
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            props.onReplace();
          }}
          disabled={saving}
          aria-label={`替换 ${it.title}`}
          title="换一家住宿"
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${
            replacing ? "border-teal-600 text-teal-700" : "border-gray-200 text-gray-500"
          } hover:border-teal-600 hover:text-teal-700`}
        >
          <SwapOutlined />
        </button>
      </div>
    </div>
  );
}

// 撤销提示里的名字：用餐写餐厅名
function nameOf(item: ItineraryItem) {
  return item.venue ? `${item.title}·${item.venue.name}` : item.title;
}

function endOf(item: ItineraryItem) {
  return item.start ? toClock(toMinutes(item.start) + item.minutes) : null;
}

function shortDate(iso: string) {
  const d = new Date(`${iso}T00:00:00`);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function formatMinutes(m: number) {
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return h ? `${h} 小时${rest ? ` ${rest} 分` : ""}` : `${rest} 分钟`;
}
