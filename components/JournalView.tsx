"use client";

import { DeleteOutlined, DownloadOutlined, PlusOutlined } from "@ant-design/icons";
import { toPng } from "html-to-image";
import { useRef, useState } from "react";
import { useIsMobile } from "@/components/PaneSwitch";
import { shrink } from "@/lib/shrink-photo";
import type { Journal, JournalPhoto } from "@/lib/types";

// "旅行后"书签的右边：游记。标题、开头、每天的小标题和正文都能直接改（离开输入框时自动保存）；
// 照片默认是高德的（标注来源），可以删掉，也可以加上自己拍的；可以导出一张竖版长图，发朋友圈或小红书

export default function JournalView({ planId, journal, onChange }: { planId: number; journal: Journal; onChange: (j: Journal) => void }) {
  const [j, setJ] = useState(journal);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 手机上一行放不下几个字，输入框按字数加高，整段都能直接看到（一行约 18 个字）
  const isMobile = useIsMobile();
  const shareRef = useRef<HTMLDivElement>(null);

  async function persist(next: Journal) {
    setJ(next);
    setSaving(true);
    try {
      const res = await fetch(`/api/plans/${planId}/journal`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ journal: next }),
      });
      const data = await res.json();
      if (!data.ok) setError(data.error);
      else onChange(data.journal);
    } catch {
      setError("保存失败：连不上服务器");
    } finally {
      setSaving(false);
    }
  }

  function setDay(index: number, patch: Partial<Journal["days"][number]>) {
    return { ...j, days: j.days.map((d) => (d.index === index ? { ...d, ...patch } : d)) };
  }

  async function upload(index: number, file: File) {
    setError(null);
    try {
      const blob = await shrink(file);
      const form = new FormData();
      form.append("file", blob, "photo.jpg");
      const res = await fetch(`/api/plans/${planId}/photos`, { method: "POST", body: form });
      const data = await res.json();
      if (!data.ok) return setError(data.error);
      const day = j.days.find((d) => d.index === index)!;
      // 自己的照片放在最前面（长图里每天用第一张）
      persist(setDay(index, { photos: [{ url: data.url, source: "user", caption: null }, ...day.photos] }));
    } catch {
      setError("照片上传失败");
    }
  }

  async function exportImage() {
    if (!shareRef.current) return;
    setExporting(true);
    setError(null);
    try {
      const url = await toPng(shareRef.current, { pixelRatio: 2, cacheBust: true, backgroundColor: "#f4f3ef" });
      const a = document.createElement("a");
      a.href = url;
      a.download = `${j.title}.png`;
      a.click();
    } catch {
      setError("导出失败：有图片没加载出来，稍等几秒再试");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-[#f4f3ef]">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 md:px-8">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-gray-500">
            游记 · 可以直接改，离开输入框时自动保存{saving ? "（保存中…）" : ""}
          </p>
          <button
            onClick={exportImage}
            disabled={exporting}
            className="flex items-center gap-1.5 rounded-full bg-gray-900 px-4 py-1.5 text-sm text-white disabled:opacity-50"
          >
            <DownloadOutlined /> {exporting ? "正在生成长图…" : "导出长图"}
          </button>
        </div>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <input
          defaultValue={j.title}
          onBlur={(e) => e.target.value !== j.title && persist({ ...j, title: e.target.value })}
          aria-label="游记标题"
          className="w-full bg-transparent text-3xl font-bold text-gray-900 outline-none"
        />
        <textarea
          defaultValue={j.summary}
          rows={isMobile ? Math.max(2, Math.ceil(j.summary.length / 18)) : 2}
          onBlur={(e) => e.target.value !== j.summary && persist({ ...j, summary: e.target.value })}
          aria-label="开头"
          className="w-full resize-none bg-transparent text-base leading-7 text-gray-700 outline-none"
        />
        <Stats journal={j} />

        {j.days.map((d) => (
          <section key={d.index} className="space-y-3 rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex items-baseline gap-3">
              <span className="text-xs text-gray-500">
                第 {d.index + 1} 天{d.date ? ` · ${d.date}` : ""} · {d.city}
              </span>
            </div>
            <input
              defaultValue={d.title}
              onBlur={(e) => e.target.value !== d.title && persist(setDay(d.index, { title: e.target.value }))}
              aria-label={`第 ${d.index + 1} 天的小标题`}
              className="w-full text-xl font-semibold text-gray-900 outline-none"
            />
            <div className="grid grid-cols-4 gap-2">
              {d.photos.map((p, i) => (
                <div key={p.url} className="group relative">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 高德图片域名不固定，不走 next/image 优化 */}
                  <img src={p.url} alt="" referrerPolicy="no-referrer" className="h-24 w-full rounded-lg object-cover" />
                  <span className="absolute bottom-1 left-1 rounded bg-black/50 px-1 text-[10px] text-white">
                    {p.source === "user" ? "我拍的" : "高德"}
                  </span>
                  <button
                    onClick={() => persist(setDay(d.index, { photos: d.photos.filter((_, k) => k !== i) }))}
                    aria-label="删掉这张照片"
                    className="absolute right-1 top-1 hidden h-6 w-6 items-center justify-center rounded-full bg-white/90 text-xs text-gray-600 group-hover:flex max-md:flex"
                  >
                    <DeleteOutlined />
                  </button>
                </div>
              ))}
              <label className="flex h-24 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 text-xs text-gray-500 hover:border-teal-600">
                <PlusOutlined />
                <span className="mt-1">加我的照片</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) upload(d.index, f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <textarea
              defaultValue={d.text}
              rows={isMobile ? Math.max(5, Math.ceil(d.text.length / 18) + 1) : 5}
              onBlur={(e) => e.target.value !== d.text && persist(setDay(d.index, { text: e.target.value }))}
              aria-label={`第 ${d.index + 1} 天的正文`}
              className="w-full resize-y rounded-lg border border-transparent p-1 text-base leading-7 text-gray-800 outline-none focus:border-gray-200"
            />
            {d.places.length > 0 && <p className="text-xs text-gray-400">去过：{d.places.join("、")}</p>}
          </section>
        ))}
        <p className="pb-6 text-xs text-gray-400">文字由 TT 根据行程和你的回答写成；地点、路线和标注「高德」的照片来自高德地图。</p>
      </div>

      {/* 导出用的长图：放在屏幕外面渲染，导出时转成图片 */}
      <div style={{ position: "fixed", left: -10000, top: 0 }} aria-hidden>
        <div ref={shareRef}>
          <ShareImage planId={planId} journal={j} />
        </div>
      </div>
    </div>
  );
}

function Stats({ journal: j }: { journal: Journal }) {
  const items = [
    [`${j.stats.days}`, "天"],
    [`${j.stats.cities}`, "座城市"],
    [`${j.stats.places}`, "个地方"],
    [`${j.stats.walkKm}`, "公里步行"],
  ];
  return (
    <div className="grid grid-cols-4 gap-2 rounded-2xl bg-white p-4 text-center shadow-sm">
      {items.map(([n, unit]) => (
        <div key={unit}>
          <p className="text-2xl font-bold text-gray-900">{n}</p>
          <p className="text-xs text-gray-500">{unit}</p>
        </div>
      ))}
    </div>
  );
}

// 竖版长图（宽 750）：标题、开头、路线图、统计、每天一张照片和正文。高德的图片经自己的服务器转发，才能画进图片里
function ShareImage({ planId, journal: j }: { planId: number; journal: Journal }) {
  const src = (p: JournalPhoto) => (p.source === "amap" ? `/api/img?u=${encodeURIComponent(p.url)}` : p.url);
  return (
    <div style={{ width: 750, padding: 40, background: "#f4f3ef", fontFamily: "system-ui, -apple-system, 'PingFang SC', sans-serif" }}>
      <p style={{ fontSize: 40, fontWeight: 700, color: "#111827", lineHeight: 1.3 }}>{j.title}</p>
      {j.summary && <p style={{ marginTop: 12, fontSize: 22, lineHeight: 1.7, color: "#374151" }}>{j.summary}</p>}
      {/* eslint-disable-next-line @next/next/no-img-element -- 自己服务器生成的路线图 */}
      <img src={`/api/plans/${planId}/staticmap`} alt="" style={{ marginTop: 24, width: 670, height: 375, objectFit: "cover", borderRadius: 16 }} />
      <div style={{ marginTop: 20, display: "flex", justifyContent: "space-around", background: "#fff", borderRadius: 16, padding: "18px 0" }}>
        {[
          [j.stats.days, "天"],
          [j.stats.cities, "座城市"],
          [j.stats.places, "个地方"],
          [j.stats.walkKm, "公里步行"],
        ].map(([n, unit]) => (
          <div key={unit} style={{ textAlign: "center" }}>
            <p style={{ fontSize: 34, fontWeight: 700, color: "#0f766e" }}>{n}</p>
            <p style={{ fontSize: 18, color: "#6b7280" }}>{unit}</p>
          </div>
        ))}
      </div>
      {j.days.map((d) => (
        <div key={d.index} style={{ marginTop: 28, background: "#fff", borderRadius: 16, padding: 24 }}>
          <p style={{ fontSize: 18, color: "#6b7280" }}>
            第 {d.index + 1} 天 · {d.city}
          </p>
          <p style={{ marginTop: 6, fontSize: 28, fontWeight: 600, color: "#111827" }}>{d.title}</p>
          {d.photos[0] && (
            // eslint-disable-next-line @next/next/no-img-element -- 导出用的图片
            <img src={src(d.photos[0])} alt="" style={{ marginTop: 16, width: 622, height: 380, objectFit: "cover", borderRadius: 12 }} />
          )}
          <p style={{ marginTop: 16, fontSize: 22, lineHeight: 1.75, color: "#1f2937", whiteSpace: "pre-wrap" }}>{d.text}</p>
        </div>
      ))}
      <p style={{ marginTop: 28, fontSize: 16, color: "#9ca3af", textAlign: "center" }}>
        TripTrace 旅行回顾 · 地点和路线来自高德地图
      </p>
    </div>
  );
}
