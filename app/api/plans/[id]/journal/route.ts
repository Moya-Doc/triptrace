import type { NextRequest } from "next/server";
import { getPlan, savePlan } from "@/lib/db";
import type { Journal } from "@/lib/types";

// 保存用户对游记的修改（标题、开头、每天的小标题和正文、照片）
export async function PUT(request: NextRequest, ctx: RouteContext<"/api/plans/[id]/journal">) {
  const { id } = await ctx.params;
  const planId = Number(id);
  const plan = getPlan(planId);
  if (!plan?.state.journal) return Response.json({ ok: false, error: "还没有游记" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { journal?: Journal };
  const j = body.journal;
  if (!j || typeof j.title !== "string" || !Array.isArray(j.days))
    return Response.json({ ok: false, error: "格式不对" }, { status: 400 });
  const journal: Journal = { ...plan.state.journal, ...j, stats: plan.state.journal.stats, updatedAt: new Date().toISOString() };
  savePlan(planId, { state: { journal } });
  return Response.json({ ok: true, journal });
}
