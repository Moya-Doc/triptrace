import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";
import { getPlan } from "@/lib/db";

// 上传自己拍的照片（游记里替换高德的照片）。浏览器先把照片压缩成 JPEG（最长边 1600 像素），
// 这里存到 data/uploads/<规划编号>/，不会提交进代码仓库
const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(request: NextRequest, ctx: RouteContext<"/api/plans/[id]/photos">) {
  const { id } = await ctx.params;
  const planId = Number(id);
  if (!getPlan(planId)) return Response.json({ ok: false, error: "这个规划不存在" }, { status: 404 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || !/^image\/(jpeg|png|webp)$/.test(file.type))
    return Response.json({ ok: false, error: "请上传 JPG、PNG 或 WebP 照片" }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ ok: false, error: "照片太大了（超过 5 MB）" }, { status: 400 });
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const name = `${randomUUID()}.${ext}`;
  const dir = path.join(process.cwd(), "data", "uploads", String(planId));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), Buffer.from(await file.arrayBuffer()));
  return Response.json({ ok: true, url: `/api/uploads/${planId}/${name}` });
}
