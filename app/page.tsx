"use client";

import { useState } from "react";
import type { StartPlanPayload } from "@/components/HomeChat";
import HomeView from "@/components/HomeView";
import PlanWorkspace from "@/components/PlanWorkspace";
import type { PlanState, PlanStatus } from "@/lib/db";

// 两个页面：首页（拍立得墙）和规划工作台

type Screen =
  | { kind: "home" }
  | {
      kind: "plan";
      key: string;
      planId: number | null;
      title: string | null;
      status: PlanStatus;
      initial: PlanState | null;
      // 从首页对话"开始规划"进入：路书已预填，打开后让 TT 先检索并说明
      kickoff: boolean;
      created: boolean;
    };

export default function Page() {
  const [screen, setScreen] = useState<Screen>({ kind: "home" });
  const [error, setError] = useState<string | null>(null);
  const [justCreatedId, setJustCreatedId] = useState<number | null>(null);

  // 开始规划：先建好规划（带着首页对话理解到的条件），再进入路书页
  async function startPlan(p: StartPlanPayload) {
    setError(null);
    try {
      const res = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setScreen({
        kind: "plan",
        key: `plan-${data.planId}`,
        planId: data.planId,
        title: data.title,
        status: "待开始",
        initial: { messages: [], constraints: p.constraints, anchor: null, candidates: [], route: null, shortlist: [] },
        kickoff: p.constraints !== null,
        created: true,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "没能开始规划");
    }
  }

  async function open(id: number) {
    setError(null);
    try {
      const res = await fetch(`/api/plans/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setScreen({
        kind: "plan",
        key: `plan-${id}`,
        planId: id,
        title: data.plan.title,
        status: data.plan.status,
        initial: data.plan.state,
        // 路书有内容、但一条消息都没有：说明上次进入规划时 TT 的第一条回复失败了，打开时补上
        kickoff: data.plan.state.messages.length === 0 && Boolean(data.plan.state.constraints),
        created: false,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "打不开这个规划");
    }
  }

  if (screen.kind === "plan") {
    return (
      <PlanWorkspace
        key={screen.key}
        planId={screen.planId}
        title={screen.title}
        status={screen.status}
        initial={screen.initial}
        kickoff={screen.kickoff}
        onHome={(planId) => {
          // 只有这次新建的规划才播放"贴上去"的动画；重新打开的旧规划不算
          setJustCreatedId(screen.created ? planId : null);
          setScreen({ kind: "home" });
        }}
      />
    );
  }

  return (
    <>
      {error && (
        <div className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700 shadow">
          {error}
        </div>
      )}
      <HomeView justCreatedId={justCreatedId} onStartPlan={startPlan} onOpen={open} />
    </>
  );
}
