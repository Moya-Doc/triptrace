"use client";

import { useSyncExternalStore } from "react";

// 手机上（窄于 md）放不下左右分屏，也不适合上下分屏：一次只看一边，用这个开关左右切换。
// 两边一直挂载、也一直有真实的宽高（只是滑到屏幕外），地图不用重建，滚动位置和正在等的回复都不会丢。
// 外层要用 overflow-clip：屏幕外那边有 scrollIntoView 时，不能把整个页面带着横向滚走

const QUERY = "(max-width: 767px)";

export function useIsMobile() {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(QUERY);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

// 这一边的滑动样式：左边的滑向左，右边的滑向右；宽屏上什么都不做
export function slide(side: "left" | "right", active: boolean) {
  const away = side === "left" ? "max-md:-translate-x-full" : "max-md:translate-x-full";
  return `max-md:transition-[translate] max-md:duration-200 ${active ? "" : away}`;
}

export default function PaneSwitch<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string; dot?: boolean }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex shrink-0 rounded-full bg-gray-200/80 p-0.5 md:hidden">
      {options.map((o) => (
        <button
          key={o.key}
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          className={`relative whitespace-nowrap rounded-full px-3 py-1 text-xs ${
            value === o.key ? "bg-white font-semibold text-gray-900 shadow-sm" : "text-gray-600"
          }`}
        >
          {o.label}
          {/* 这一边有新变化，还没看 */}
          {o.dot && <span className="absolute right-1 top-0.5 h-1.5 w-1.5 rounded-full bg-red-500" />}
        </button>
      ))}
    </div>
  );
}
