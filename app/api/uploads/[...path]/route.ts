import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";

// 读取上传的照片：只允许 data/uploads/<规划编号>/<文件名> 这一种路径，防止读到别的文件
const TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/uploads/[...path]">) {
  const { path: parts } = await ctx.params;
  if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(parts[1]))
    return new Response("not found", { status: 404 });
  const file = path.join(process.cwd(), "data", "uploads", parts[0], parts[1]);
  if (!existsSync(file)) return new Response("not found", { status: 404 });
  const ext = parts[1].split(".").pop()!;
  return new Response(readFileSync(file), {
    headers: { "Content-Type": TYPES[ext], "Cache-Control": "private, max-age=86400" },
  });
}
