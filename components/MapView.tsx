"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Candidate, GeoPoint, RoutePlan } from "@/lib/types";

// 高德 JS API 2.0 地图。Key 和安全密钥从 NEXT_PUBLIC_ 环境变量读取，只适合本地演示。

type Overlay = { on: (event: string, fn: () => void) => void };
type AMapMap = Overlay & {
  setZoomAndCenter: (zoom: number, center: [number, number]) => void;
  panTo: (center: [number, number]) => void;
  setFitView: (overlays?: Overlay[], immediately?: boolean, avoid?: number[], maxZoom?: number) => void;
  add: (overlay: Overlay | Overlay[]) => void;
  remove: (overlay: Overlay | Overlay[]) => void;
  setStatus: (status: { dragEnable: boolean }) => void;
  resize: () => void;
  destroy: () => void;
};
type AMapNamespace = {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => AMapMap;
  Marker: new (opts: Record<string, unknown>) => Overlay;
  Polyline: new (opts: Record<string, unknown>) => Overlay;
};

const JS_KEY = process.env.NEXT_PUBLIC_AMAP_JS_KEY;
const SECURITY_CODE = process.env.NEXT_PUBLIC_AMAP_SECURITY_CODE;

// 满足全部条件：青绿；满足一部分：琥珀；都不满足：灰
export function pinColor(c: Candidate) {
  if (c.color) return c.color;
  if (c.maxScore === 0 || c.score === c.maxScore) return "#0f766e";
  return c.score > 0 ? "#d97706" : "#9ca3af";
}

type Props = {
  anchor: GeoPoint | null;
  candidates: Candidate[];
  route: RoutePlan | null;
  selectedId: string | null;
  shortlistIds: string[];
  onSelect: (id: string) => void;
  onMapClick: () => void;
  // 地图底部候选栏的高度：图钉被拖进这个区域就算加入候选
  dropZoneHeight: number;
  onDragOverDropZone: (over: boolean) => void;
  onDropToShortlist: (id: string) => void;
  // 选中某个图钉时把地图平移过去（单日详情里，点列表中的候选地点，地图跟着过去）
  followSelected?: boolean;
  // 单日详情：按顺序把这一天的地点用弧线连起来。有 label 的段（对应一段交通）在弧线中间标出交通方式，
  // 点弧线或标签可以改交通方式
  segments?: MapSegment[];
  activeSegment?: string | null;
  onSegmentClick?: (key: string) => void;
  // 自动调整视野时最多放大到几级：找地点时 14 级（一座城市的范围），单日详情的地点常在一两公里内，放到 17 级
  maxZoom?: number;
};

export type MapSegment = {
  key: string;
  from: GeoPoint;
  to: GeoPoint;
  label: string | null;
  // 真实路径（单日详情按需查询）；还没查到或查不到时画弧线
  pieces?: MapPiece[];
};

export type MapPiece = { kind: "walk" | "drive" | "subway" | "bus"; name: string | null; points: [number, number][] };

// 地铁按线路名分配颜色（同一条线颜色固定），公交蓝色，驾车 / 打车青绿，步行灰色虚线
const SUBWAY_COLORS = ["#e4002b", "#0072ce", "#f39800", "#009944", "#8e44ad", "#00a0e9", "#d4237a", "#7c6a0a"];

function pieceColor(p: MapPiece) {
  if (p.kind === "walk") return "#6b7280";
  if (p.kind === "bus") return "#2563eb";
  if (p.kind === "drive") return "#0f766e";
  const name = p.name ?? "";
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SUBWAY_COLORS[h % SUBWAY_COLORS.length];
}

export default function MapView(props: Props) {
  const { anchor, candidates, route, selectedId, shortlistIds, dropZoneHeight } = props;
  const maxZoom = props.maxZoom ?? 14;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<AMapMap | null>(null);
  const amapRef = useRef<AMapNamespace | null>(null);
  const overlaysRef = useRef<Overlay[]>([]);
  // 回调放进 ref，地图事件里总能拿到最新的版本，又不用因此重画标记
  const handlersRef = useRef(props);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    handlersRef.current = props;
  });

  useEffect(() => {
    if (!JS_KEY || !SECURITY_CODE || !containerRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        (window as unknown as { _AMapSecurityConfig: unknown })._AMapSecurityConfig = {
          securityJsCode: SECURITY_CODE,
        };
        const { default: AMapLoader } = await import("@amap/amap-jsapi-loader");
        const AMap = (await AMapLoader.load({ key: JS_KEY, version: "2.0" })) as AMapNamespace;
        if (cancelled || !containerRef.current) return;
        amapRef.current = AMap;
        const map = new AMap.Map(containerRef.current, {
          zoom: 5,
          center: [104.07, 30.67],
          viewMode: "2D",
          resizeEnable: true,
        });
        // 点击地图空白处，收起详情卡片（点击图钉不会触发这个事件）
        map.on("click", () => handlersRef.current.onMapClick());
        mapRef.current = map;
        setReady(true);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      mapRef.current?.destroy();
      mapRef.current = null;
    };
  }, []);

  // 拖动图钉：自己处理指针事件，生成一个跟随指针的"影子"，松手时判断是否落在底部候选栏里。
  // 不用地图自带的拖动，因为指针移到候选栏上方后，地图就收不到事件了。
  // 移动不到 6 像素就松手，算作点击，打开详情卡片。
  function startPinDrag(down: PointerEvent, el: HTMLElement, id: string) {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container || down.button !== 0) return;
    down.preventDefault();
    map.setStatus({ dragEnable: false });
    let ghost: HTMLElement | null = null;

    const overDropZone = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      return ev.clientY > rect.bottom - handlersRef.current.dropZoneHeight && ev.clientY < rect.bottom;
    };
    const move = (ev: PointerEvent) => {
      if (!ghost && Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < 6) return;
      if (!ghost) {
        ghost = el.cloneNode(true) as HTMLElement;
        Object.assign(ghost.style, { position: "fixed", pointerEvents: "none", zIndex: "1000", opacity: "0.9" });
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${ev.clientX - ghost.offsetWidth / 2}px`;
      ghost.style.top = `${ev.clientY - 30}px`;
      handlersRef.current.onDragOverDropZone(overDropZone(ev));
    };
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      map.setStatus({ dragEnable: true });
      handlersRef.current.onDragOverDropZone(false);
      if (ghost) {
        ghost.remove();
        if (overDropZone(ev)) handlersRef.current.onDropToShortlist(id);
      } else {
        handlersRef.current.onSelect(id);
      }
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  // 参照城市、候选地点或选中状态变化时，重画所有标记
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!ready || !map || !AMap) return;
    map.remove(overlaysRef.current);
    const overlays: Overlay[] = [];

    if (anchor) {
      overlays.push(
        new AMap.Marker({
          position: [anchor.lng, anchor.lat],
          content: `<div class="whitespace-nowrap rounded-full bg-gray-900 px-2 py-1 text-xs text-white shadow">★ ${escapeHtml(anchor.name)}</div>`,
          anchor: "center",
          zIndex: 200,
        }),
      );
    }

    for (const c of candidates) {
      const el = document.createElement("div");
      el.innerHTML = pinHtml(c, c.id === selectedId, shortlistIds.includes(c.id));
      el.addEventListener("pointerdown", (ev) => startPinDrag(ev, el, c.id));
      overlays.push(
        new AMap.Marker({
          position: [c.lng, c.lat],
          content: el,
          anchor: "bottom-center",
          zIndex: c.id === selectedId ? 300 : 100 + Math.max(0, candidates.length - c.rank),
        }),
      );
    }

    // 单日详情的路线：有真实路径就按路径画（默认淡一些，选中的那一段加粗、不透明），否则画弧线
    for (const seg of props.segments ?? []) {
      if (samePoint(seg.from, seg.to)) continue;
      const active = seg.key === props.activeSegment;
      const lines: Overlay[] = [];
      let mid: [number, number];
      if (seg.pieces?.length) {
        seg.pieces.forEach((piece, k) => {
          lines.push(
            new AMap.Polyline({
              path: piece.points,
              strokeColor: pieceColor(piece),
              strokeWeight: active ? 8 : 5,
              strokeOpacity: active ? 0.95 : 0.6,
              strokeStyle: piece.kind === "walk" ? "dashed" : "solid",
              strokeDasharray: [8, 6],
              showDir: piece.kind !== "walk",
              lineJoin: "round",
              lineCap: "round",
              cursor: seg.label ? "pointer" : "default",
              zIndex: active ? 95 : 90,
            }),
          );
          // 换乘点：公交地铁的两段之间画一个小圆点
          if (k > 0) {
            overlays.push(
              new AMap.Marker({
                position: piece.points[0],
                content: `<div class="tt-transfer" style="border-color:${pieceColor(piece)}"></div>`,
                anchor: "center",
                zIndex: 96,
              }),
            );
          }
        });
        const all = seg.pieces.flatMap((p) => p.points);
        mid = all[Math.floor(all.length / 2)];
      } else {
        const a = arc(seg.from, seg.to);
        mid = a.mid;
        lines.push(
          new AMap.Polyline({
            path: a.path,
            strokeColor: active ? "#d97706" : "#0f766e",
            strokeWeight: active ? 6 : 4,
            strokeOpacity: 0.8,
            showDir: true,
            lineJoin: "round",
            lineCap: "round",
            cursor: seg.label ? "pointer" : "default",
            zIndex: 90,
          }),
        );
      }
      overlays.push(...lines);
      if (!seg.label) continue;
      for (const line of lines) line.on("click", () => handlersRef.current.onSegmentClick?.(seg.key));
      const el = document.createElement("div");
      el.className = `tt-leg tt-leg--click${active ? " tt-leg--active" : ""}`;
      el.textContent = seg.label;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        handlersRef.current.onSegmentClick?.(seg.key);
      });
      overlays.push(new AMap.Marker({ position: mid, content: el, anchor: "center", zIndex: 260 }));
    }

    // 可行性检查的路线：按顺序给城市编号，相邻两站之间画带箭头的直线，线中间标出交通时间。
    // 只用到已有的定位和交通时间数据，画线本身不额外调用接口
    if (route) {
      route.stops.forEach((s, i) => {
        // 原路返回时终点和起点是同一个城市，不重复标记
        if (route.stops.findIndex((x) => x.name === s.name) !== i) return;
        overlays.push(
          new AMap.Marker({
            position: [s.lng, s.lat],
            content: `<div class="tt-stop"><span>${i + 1}</span>${escapeHtml(s.name)}</div>`,
            anchor: "center",
            zIndex: 250,
          }),
        );
      });
      route.legs.forEach((leg, i) => {
        const a = route.stops[i];
        const b = route.stops[i + 1];
        if (!a || !b) return;
        // 每段路线画成一条平滑的弧线（二次贝塞尔曲线，取 24 个点），看起来像飞行航线，
        // 不会被误会成中途经过某个点。弧的方向由起终点决定，所以一来一回会自然分在两侧
        const { path, mid } = arc(a, b);
        overlays.push(
          new AMap.Polyline({
            path,
            strokeColor: "#0f766e",
            strokeWeight: 6,
            strokeOpacity: leg.assumed ? 0.5 : 0.85,
            strokeStyle: leg.assumed ? "dashed" : "solid",
            strokeDasharray: [12, 8],
            showDir: true,
            lineJoin: "round",
            lineCap: "round",
            zIndex: 150,
          }),
          new AMap.Marker({
            position: mid,
            content: `<div class="tt-leg">${leg.assumed ? "返程（假设）· " : ""}${leg.minutes === null ? "没查到" : formatMinutes(leg.minutes)}${leg.via ? ` · ${escapeHtml(leg.via)}` : ""}</div>`,
            anchor: "center",
            zIndex: 260,
          }),
        );
      });
    }

    map.add(overlays);
    overlaysRef.current = overlays;
  }, [anchor, candidates, route, selectedId, shortlistIds, ready, props.segments, props.activeSegment]);

  useEffect(() => {
    if (!ready || !props.followSelected || !selectedId) return;
    const c = candidates.find((x) => x.id === selectedId);
    if (c) mapRef.current?.panTo([c.lng, c.lat]);
  }, [ready, props.followSelected, selectedId, candidates]);

  // 结果变化时调整视野；上方留出切换胶囊，下方留出候选栏
  const fitView = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    // 只有一个地点时，自动缩放的结果不可靠（有时放得太大，有时又缩到整个省），直接以它为中心
    if (candidates.length === 1 && !route?.stops.length && !anchor)
      map.setZoomAndCenter(13, [candidates[0].lng, candidates[0].lat]);
    else if (candidates.length || route?.stops.length)
      map.setFitView(overlaysRef.current, false, [130, 40 + dropZoneHeight, 80, 80], maxZoom);
    else if (anchor) map.setZoomAndCenter(9, [anchor.lng, anchor.lat]);
  }, [anchor, candidates, route, dropZoneHeight, maxZoom]);

  useEffect(() => {
    if (ready) fitView();
  }, [ready, fitView]);

  // 容器尺寸变化（比如从"各占一半"切到"全屏地图"）时，高德地图不会自己察觉，
  // 只在原来的区域里绘制，所以要通知它重新计算大小；尺寸稳定下来后再把结果重新放进视野
  useEffect(() => {
    const el = containerRef.current;
    if (!ready || !el) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      mapRef.current?.resize();
      clearTimeout(timer);
      timer = setTimeout(fitView, 350);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [ready, fitView]);

  if (!JS_KEY || !SECURITY_CODE) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#e9ece8] p-8">
        <p className="max-w-sm text-center text-sm leading-6 text-gray-600">
          还没有配置高德 JS API 的 Key 和安全密钥。
          <br />
          在 <code>.env.local</code> 里填写 <code>NEXT_PUBLIC_AMAP_JS_KEY</code> 和{" "}
          <code>NEXT_PUBLIC_AMAP_SECURITY_CODE</code>，然后重启开发服务器。
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <style>{PIN_CSS}</style>
      <div ref={containerRef} className="h-full w-full" />
      {loadError && (
        <div className="absolute inset-x-4 top-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 shadow">
          地图加载失败：{loadError}
        </div>
      )}
    </div>
  );
}

function pinHtml(c: Candidate, selected: boolean, shortlisted: boolean) {
  const img = c.photo
    ? `<img src="${escapeHtml(c.photo)}" referrerpolicy="no-referrer" alt="" />`
    : `<span>⛺</span>`;
  const drive = c.driveMinutes === null ? "" : ` · ${c.driveMinutes} 分钟`;
  return `<div class="tt-pin${selected ? " tt-pin--selected" : ""}" style="--pin:${pinColor(c)}">
    <div class="tt-pin__headwrap">
      <div class="tt-pin__head">${img}</div>
      <div class="tt-pin__rank">${escapeHtml(c.badge ?? String(c.rank))}</div>
    </div>
    <div class="tt-pin__label">${shortlisted ? "★ " : ""}${escapeHtml(c.name.slice(0, 10))}${drive}</div>
  </div>`;
}

// 图钉的样式和 HTML 放在一起维护。圆形、底部带尖角，圆内是地点的真实照片，边框颜色表示满足了几个条件
const PIN_CSS = `
.tt-pin {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.tt-pin__headwrap {
  position: relative;
}
.tt-pin__head {
  width: 46px;
  height: 46px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  border: 3px solid var(--pin);
  background: #fff;
  overflow: hidden;
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.3);
}
.tt-pin__head img,
.tt-pin__head span {
  width: 100%;
  height: 100%;
  transform: rotate(45deg) scale(1.45);
  object-fit: cover;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
}
.tt-pin__rank {
  position: absolute;
  top: -6px;
  right: -8px;
  min-width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--pin);
  color: #fff;
  font-size: 12px;
  line-height: 20px;
  text-align: center;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
}
.tt-pin__label {
  margin-top: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgb(255 255 255 / 0.95);
  color: #1f2328;
  font-size: 11px;
  white-space: nowrap;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
}
.tt-stop {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 4px 4px;
  border-radius: 999px;
  background: #1f2328;
  color: #fff;
  font-size: 13px;
  white-space: nowrap;
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.3);
}
.tt-stop span {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: #0f766e;
  text-align: center;
  line-height: 20px;
  font-size: 12px;
}
.tt-leg {
  padding: 2px 8px;
  border-radius: 999px;
  background: #fff;
  color: #0f766e;
  border: 1px solid #0f766e;
  font-size: 12px;
  white-space: nowrap;
}
.tt-leg--click { cursor: pointer; }
.tt-leg--click:hover { border-color: #0f766e; }
.tt-leg--active { border-color: #d97706; color: #92400e; }
.tt-transfer {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: #fff;
  border: 3px solid #0f766e;
}
.tt-pin--selected .tt-pin__head {
  width: 56px;
  height: 56px;
  border-width: 4px;
}
`;

// 二次贝塞尔弧线：控制点在两点连线的垂直方向上偏移 20% 的距离
function arc(a: GeoPoint, b: GeoPoint) {
  const bend = 0.2;
  const cx = (a.lng + b.lng) / 2 - (b.lat - a.lat) * bend;
  const cy = (a.lat + b.lat) / 2 + (b.lng - a.lng) * bend;
  const point = (t: number): [number, number] => [
    (1 - t) ** 2 * a.lng + 2 * (1 - t) * t * cx + t ** 2 * b.lng,
    (1 - t) ** 2 * a.lat + 2 * (1 - t) * t * cy + t ** 2 * b.lat,
  ];
  return { path: Array.from({ length: 25 }, (_, i) => point(i / 24)), mid: point(0.5) };
}

function samePoint(a: GeoPoint, b: GeoPoint) {
  return Math.abs(a.lng - b.lng) < 1e-6 && Math.abs(a.lat - b.lat) < 1e-6;
}

function formatMinutes(m: number) {
  const h = Math.floor(m / 60);
  return h ? `${h} 小时${m % 60 ? ` ${m % 60} 分` : ""}` : `${m} 分钟`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
