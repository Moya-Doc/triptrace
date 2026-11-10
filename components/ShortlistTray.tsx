"use client";

import type { Candidate } from "@/lib/types";

// 地图底部的候选栏：把图钉拖进来，TT 会优先围绕这些地点给建议

export const TRAY_HEIGHT = 96;

type Props = {
  items: Candidate[];
  dragOver: boolean;
  disabled: boolean;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
  onCompare: () => void;
};

export default function ShortlistTray({ items, dragOver, disabled, onRemove, onSelect, onCompare }: Props) {
  return (
    <div
      style={{ height: TRAY_HEIGHT }}
      className={`absolute inset-x-0 bottom-0 z-10 flex items-center gap-3 border-t px-4 backdrop-blur transition-colors ${
        dragOver ? "border-teal-600 bg-teal-50/95" : "border-gray-200 bg-white/90"
      }`}
    >
      {items.length === 0 ? (
        <p className={`flex-1 text-center text-sm ${dragOver ? "text-teal-800" : "text-gray-400"}`}>
          {dragOver ? "松手，加入候选" : "把喜欢的图钉拖到这里，TT 会优先考虑它们"}
        </p>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto py-1">
            {items.map((c) => (
              <div
                key={c.id}
                className="flex shrink-0 items-center gap-2 rounded-xl border border-gray-200 bg-white py-1.5 pl-1.5 pr-2"
              >
                <button onClick={() => onSelect(c.id)} className="flex items-center gap-2 text-left">
                  {c.photo ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 高德图片域名不固定，不走 next/image 优化
                    <img
                      src={c.photo}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="h-10 w-10 rounded-lg object-cover"
                    />
                  ) : (
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100">⛺</span>
                  )}
                  <span>
                    <span className="block max-w-[9rem] truncate text-sm">{c.name}</span>
                    <span className="block text-xs text-gray-500">
                      {c.district}
                      {c.driveMinutes !== null && ` · ${c.driveMinutes} 分钟`}
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => onRemove(c.id)}
                  aria-label={`移出候选：${c.name}`}
                  className="text-gray-400 hover:text-gray-700"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {items.length >= 2 && (
            <button
              onClick={onCompare}
              disabled={disabled}
              className="shrink-0 rounded-full bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-40"
            >
              让 TT 比较
            </button>
          )}
        </>
      )}
    </div>
  );
}
