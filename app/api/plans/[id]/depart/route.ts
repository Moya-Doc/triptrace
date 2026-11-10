import type { NextRequest } from "next/server";
import { getPlan, savePlan } from "@/lib/db";

// 「出发」：把现在的行程存一份，作为"出发时的计划"（只读）。之后路上的修改仍然改同一份行程，
// 基准只用来对比计划和实际。再点一次会用现在的行程覆盖基准；DELETE 是"还没出发"，清掉基准
export async function POST(_req: NextRequest, ctx: RouteContext<"/api/plans/[id]/depart">) {
  const { id } = await ctx.params;
  const planId = Number(id);
  const itinerary = getPlan(planId)?.state.itinerary;
  if (!itinerary) return Response.json({ ok: false, error: "还没有生成行程" }, { status: 404 });
  const departure = { at: new Date().toISOString(), itinerary };
  savePlan(planId, { state: { departure } });
  return Response.json({ ok: true, departure });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<"/api/plans/[id]/depart">) {
  const { id } = await ctx.params;
  const planId = Number(id);
  if (!getPlan(planId)) return Response.json({ ok: false, error: "这个规划不存在" }, { status: 404 });
  savePlan(planId, { state: { departure: null } });
  return Response.json({ ok: true });
}
