import type { NextRequest } from "next/server";

// 转发高德的图片：导出长图时要把图片画进画布，浏览器不允许直接用别的网站的图片，所以经自己的服务器转一下。
// 只转发高德的图片域名，防止被当成任意网址的代理
const ALLOWED = /^https:\/\/([a-z0-9-]+\.)*(amap\.com|autonavi\.com)\//;

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("u") ?? "";
  if (!ALLOWED.test(url)) return new Response("forbidden", { status: 403 });
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) return new Response("not found", { status: 404 });
  return new Response(await res.arrayBuffer(), {
    headers: { "Content-Type": res.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "private, max-age=86400" },
  });
}
