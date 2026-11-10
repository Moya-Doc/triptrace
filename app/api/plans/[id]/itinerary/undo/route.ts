import type { NextRequest } from "next/server";
import { getPlan, savePlan, undoItinerary, undoState } from "@/lib/db";

// 撤销：GET 返回还能撤销几步、最近一步是什么；POST 撤销最近一步，并在对话里记一句，让 TT 知道行程被改回去了
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/plans/[id]/itinerary/undo">) {
  const { id } = await ctx.params;
  return Response.json({ ok: true, undo: undoState(Number(id)) });
}

export async function POST(_req: NextRequest, ctx: RouteContext<"/api/plans/[id]/itinerary/undo">) {
  const { id } = await ctx.params;
  const planId = Number(id);
  const result = undoItinerary(planId);
  if (!result) return Response.json({ ok: false, error: "没有可以撤销的修改" }, { status: 400 });
  const message = { role: "assistant" as const, content: `已撤销：${result.label}。` };
  savePlan(planId, { state: { messages: [...(getPlan(planId)?.state.messages ?? []), message] } });
  return Response.json({ ok: true, itinerary: result.itinerary, message, undo: result.undo });
}
