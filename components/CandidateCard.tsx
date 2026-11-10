"use client";

import { pinColor } from "@/components/MapView";
import type { Candidate } from "@/lib/types";

// 点开图钉后的详情卡片：每一条信息都来自高德，用户可以自己核对（可验证性）

type Props = {
  c: Candidate;
  shortlisted: boolean;
  onToggleShortlist: () => void;
  onClose: () => void;
};

export default function CandidateCard({ c, shortlisted, onToggleShortlist, onClose }: Props) {
  const query = encodeURIComponent(c.name);
  return (
    <div className="absolute bottom-4 left-4 right-4 z-10 overflow-hidden rounded-2xl bg-white shadow-xl md:left-auto md:w-[340px]">
      {c.photo && (
        // eslint-disable-next-line @next/next/no-img-element -- 高德图片域名不固定，不走 next/image 优化
        <img src={c.photo} alt={c.name} referrerPolicy="no-referrer" className="h-36 w-full object-cover" />
      )}
      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span
                className="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs text-white"
                style={{ background: pinColor(c) }}
              >
                {c.rank}
              </span>
              <h2 className="text-base font-semibold">{c.name}</h2>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {c.district}
              {c.address && ` · ${c.address}`}
              {c.rating !== null && ` · 评分 ${c.rating}`}
            </p>
          </div>
          <button onClick={onClose} aria-label="关闭" className="text-gray-400 hover:text-gray-700">
            ×
          </button>
        </div>

        <ul className="space-y-1.5 text-sm">
          {c.checks.map((ch) => (
            <li key={ch.label} className="flex gap-2">
              <span className={ch.ok ? "text-teal-700" : "text-gray-400"}>{ch.ok ? "✓" : "✗"}</span>
              <span>
                <span className="text-gray-500">{ch.label}：</span>
                {ch.detail}
              </span>
            </li>
          ))}
          {c.distanceKm !== null && (
            <li className="flex gap-2 text-gray-500">
              <span>·</span>
              <span>驾车距离 {c.distanceKm} 公里</span>
            </li>
          )}
        </ul>

        <button
          onClick={onToggleShortlist}
          className={`w-full rounded-lg py-2 text-sm ${
            shortlisted ? "border border-gray-200 text-gray-600" : "bg-gray-900 text-white"
          }`}
        >
          {shortlisted ? "移出候选" : "加入候选"}
        </button>

        <div className="flex items-center justify-between border-t border-gray-100 pt-2 text-[11px] text-gray-400">
          <span>数据来源：高德地图</span>
          <a
            href={`https://uri.amap.com/marker?position=${c.lng},${c.lat}&name=${query}`}
            target="_blank"
            rel="noreferrer"
            className="text-teal-700 hover:underline"
          >
            在高德地图中打开 →
          </a>
        </div>
      </div>
    </div>
  );
}
