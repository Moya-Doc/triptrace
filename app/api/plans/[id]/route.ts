import type { NextRequest } from "next/server";
import { getPlan, savePlan, setPlanStatus, type PlanState, type PlanStatus } from "@/lib/db";

// 读取一个规划的完整状态，用于在首页重新打开
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/plans/[id]">) {
  const { id } = await ctx.params;
  const plan = getPlan(Number(id));
  if (!plan) return Response.json({ error: "这个规划不存在" }, { status: 404 });
  return Response.json({ plan });
}

// 修改规划：标注状态（待开始 / 已完成）、保存候选栏，或保存在路书上直接修改的字段
export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/plans/[id]">) {
  const { id } = await ctx.params;
  const planId = Number(id);
  if (!getPlan(planId)) return Response.json({ error: "这个规划不存在" }, { status: 404 });
  const body = (await request.json()) as {
    status?: PlanStatus;
    shortlist?: PlanState["shortlist"];
    constraints?: PlanState["constraints"];
    itinerary?: PlanState["itinerary"];
  };
  if (body.status === "待开始" || body.status === "已完成") setPlanStatus(planId, body.status);
  if (body.shortlist) savePlan(planId, { state: { shortlist: body.shortlist } });
  // 在路书上直接改的字段（日期、交通、住宿等）
  if (body.constraints) savePlan(planId, { state: { constraints: body.constraints } });
  // 行程里某一天标记为完成
  if (body.itinerary) savePlan(planId, { state: { itinerary: body.itinerary } });
  return Response.json({ plan: getPlan(planId) });
}
