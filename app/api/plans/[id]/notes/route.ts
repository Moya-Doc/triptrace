import type { NextRequest } from "next/server";
import { getPlan, savePlan } from "@/lib/db";
import type { TripNote } from "@/lib/types";

// 保存路上写的一条记录（文字 + 自己的照片，照片先经 /photos 上传）。文字和照片都清空就删掉这条
export async function PUT(request: NextRequest, ctx: RouteContext<"/api/plans/[id]/notes">) {
  const { id } = await ctx.params;
  const planId = Number(id);
  const plan = getPlan(planId);
  if (!plan) return Response.json({ ok: false, error: "这个规划不存在" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { key?: unknown; text?: unknown; photos?: unknown };
  if (typeof body.key !== "string" || !/^\d+\|.+$/.test(body.key) || typeof body.text !== "string")
    return Response.json({ ok: false, error: "格式不对" }, { status: 400 });
  // 只接受自己上传的照片
  const photos = Array.isArray(body.photos)
    ? body.photos.filter((p): p is string => typeof p === "string" && p.startsWith(`/api/uploads/${planId}/`))
    : [];
  const notes = { ...(plan.state.notes ?? {}) };
  const text = body.text.slice(0, 2000);
  if (text.trim() || photos.length) notes[body.key] = { text, photos, updatedAt: new Date().toISOString(), fromChat: notes[body.key]?.fromChat } satisfies TripNote;
  else delete notes[body.key];
  savePlan(planId, { state: { notes } });
  return Response.json({ ok: true, notes });
}
