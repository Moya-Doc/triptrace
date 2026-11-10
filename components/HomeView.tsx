"use client";

import { useEffect, useState } from "react";
import HomeChat, { type StartPlanPayload } from "@/components/HomeChat";
import PaneSwitch, { slide, useIsMobile } from "@/components/PaneSwitch";
import type { PlanStatus, PlanSummary } from "@/lib/db";

// 首页：左边是发散模式的对话（HomeChat）；右边是一面墙，每个规划像一张拍立得贴在上面。
// 灵感池在后台默默起作用，不在首页展示（2026-11-02 用户决定：灵感池应该是内化的）。

type Props = {
  // 刚刚新建的规划：回到首页时，它会像拍立得一样"贴"上墙
  justCreatedId: number | null;
  onStartPlan: (p: StartPlanPayload) => void;
  onOpen: (id: number) => void;
};

export default function HomeView({ justCreatedId, onStartPlan, onOpen }: Props) {
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  // 手机上一次只看一边：对话 / 规划墙
  const [pane, setPane] = useState<"chat" | "wall">("chat");
  const isMobile = useIsMobile();

  useEffect(() => {
    fetch("/api/plans")
      .then((r) => r.json())
      .then((d) => setPlans(d.plans))
      .catch(() => setPlans([]));
  }, []);

  function toggle(p: PlanSummary) {
    const status: PlanStatus = p.status === "已完成" ? "待开始" : "已完成";
    setPlans((list) => list?.map((x) => (x.id === p.id ? { ...x, status } : x)) ?? null);
    fetch(`/api/plans/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }).catch(() => {});
  }

  return (
    <main className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-clip md:grid-cols-[420px_minmax(0,1fr)]">
      <style>{POLAROID_CSS}</style>
      <div className="col-start-1 row-start-1 flex justify-center border-b border-gray-200 bg-[#fbfbfa] py-2 md:hidden">
        <PaneSwitch
          value={pane}
          onChange={setPane}
          options={[
            { key: "chat", label: "聊念头" },
            { key: "wall", label: "我的规划" },
          ]}
        />
      </div>
      <div inert={isMobile && pane !== "chat"} className={`col-start-1 row-start-2 min-h-0 ${slide("left", pane === "chat")}`}>
        <HomeChat onStartPlan={onStartPlan} />
      </div>

      <section
        inert={isMobile && pane !== "wall"}
        className={`relative col-start-1 row-start-2 min-h-0 min-w-0 overflow-y-auto bg-[#efede7] md:col-start-2 ${slide("right", pane === "wall")}`}
      >
        {plans?.length === 0 && (
          <p className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-gray-400">
            还没有规划。在左边聊聊念头，开始规划后，它就会贴在这里。
          </p>
        )}
        <div className="flex flex-wrap content-start justify-center gap-x-8 gap-y-10 p-6 md:justify-start md:p-10">
          {plans?.map((p) => (
            <Polaroid
              key={p.id}
              plan={p}
              fresh={p.id === justCreatedId}
              onOpen={() => onOpen(p.id)}
              onToggle={() => toggle(p)}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function Polaroid({
  plan: p,
  fresh,
  onOpen,
  onToggle,
}: {
  plan: PlanSummary;
  fresh: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  // 每张照片固定一个随机的小角度，看起来像是随手贴上去的
  const tilt = ((p.id * 37) % 9) - 4;
  const done = p.status === "已完成";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      style={{ "--tilt": `${tilt}deg` } as React.CSSProperties}
      className={`tt-polaroid ${fresh ? "tt-polaroid--fresh" : ""} ${done ? "tt-polaroid--done" : ""}`}
    >
      <span className="tt-polaroid__tape" />
      <div className="tt-polaroid__photo">
        {p.cover.photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- 高德图片域名不固定，不走 next/image 优化
          <img src={p.cover.photo} alt="" referrerPolicy="no-referrer" />
        ) : p.cover.stops.length ? (
          <div className="tt-polaroid__route">
            {p.cover.stops.map((s, i) => (
              <span key={i}>
                {i > 0 && <em>→</em>}
                {s}
              </span>
            ))}
          </div>
        ) : (
          <div className="tt-polaroid__blank">还在想去哪儿</div>
        )}
        {done && <span className="tt-polaroid__stamp">已完成</span>}
      </div>
      <div className="tt-polaroid__caption">{p.title}</div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-gray-400">
        <span>{formatDate(p.createdAt)}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="rounded px-1 hover:bg-gray-100 hover:text-gray-700"
        >
          {done ? "改回待开始" : "标记完成"}
        </button>
      </div>
    </div>
  );
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

// 拍立得的样式：白边、底部留白写字、一小段胶带；新贴上的那张有一个"拍上去"的动画
const POLAROID_CSS = `
.tt-polaroid {
  position: relative;
  width: 200px;
  padding: 10px 10px 12px;
  background: #fff;
  box-shadow: 0 6px 16px rgb(0 0 0 / 0.12), 0 1px 3px rgb(0 0 0 / 0.08);
  transform: rotate(var(--tilt));
  transition: transform 0.2s, box-shadow 0.2s;
  cursor: pointer;
}
.tt-polaroid:hover {
  transform: rotate(0deg) translateY(-4px) scale(1.03);
  box-shadow: 0 12px 28px rgb(0 0 0 / 0.18);
  z-index: 1;
}
.tt-polaroid--done { opacity: 0.75; }
.tt-polaroid__tape {
  position: absolute;
  top: -10px;
  left: 50%;
  width: 64px;
  height: 20px;
  transform: translateX(-50%) rotate(-3deg);
  background: rgb(250 240 200 / 0.85);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
}
.tt-polaroid__photo {
  position: relative;
  height: 170px;
  overflow: hidden;
  background: #e7ebe6;
}
.tt-polaroid__photo img { width: 100%; height: 100%; object-fit: cover; }
.tt-polaroid__route,
.tt-polaroid__blank {
  height: 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 12px;
  color: #0f766e;
  font-size: 15px;
  text-align: center;
}
.tt-polaroid__route em { font-style: normal; margin: 0 4px; color: #9ca3af; }
.tt-polaroid__blank { color: #9ca3af; font-size: 13px; }
.tt-polaroid__stamp {
  position: absolute;
  right: 8px;
  bottom: 10px;
  padding: 2px 8px;
  border: 2px solid #b91c1c;
  border-radius: 4px;
  color: #b91c1c;
  font-size: 13px;
  font-weight: 600;
  transform: rotate(-12deg);
  background: rgb(255 255 255 / 0.7);
}
.tt-polaroid__caption {
  margin-top: 10px;
  min-height: 2.6em;
  font-family: "Kaiti SC", "STKaiti", "KaiTi", serif;
  font-size: 15px;
  line-height: 1.3;
  color: #1f2328;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tt-polaroid--fresh { animation: tt-stick 0.6s cubic-bezier(0.2, 0.9, 0.3, 1.2); }
@keyframes tt-stick {
  0% { opacity: 0; transform: translateY(-40px) rotate(calc(var(--tilt) - 12deg)) scale(1.15); }
  70% { opacity: 1; transform: translateY(4px) rotate(calc(var(--tilt) + 2deg)) scale(0.98); }
  100% { transform: rotate(var(--tilt)); }
}
`;
