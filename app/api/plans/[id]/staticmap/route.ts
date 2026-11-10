import type { NextRequest } from "next/server";
import { getPlan } from "@/lib/db";

// 长图里的路线图：用高德静态地图接口生成一张图片（标出去过的地方，按顺序连线）。
// Key 只在服务端用，浏览器拿到的只是图片
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/plans/[id]/staticmap">) {
  const { id } = await ctx.params;
  const itinerary = getPlan(Number(id))?.state.itinerary;
  const key = process.env.AMAP_WEB_SERVICE_KEY;
  if (!itinerary || !key) return new Response("not found", { status: 404 });
  // 和游记一样按天判断去过哪：那天打过勾就以打勾为准，否则按计划
  const points = itinerary.days
    .flatMap((d) => {
      const dayDone = d.items.some((x) => x.done && (x.kind === "place" || x.kind === "free"));
      return d.items.filter((x) => !dayDone || x.done);
    })
    .filter((x) => x.kind === "place" && x.lng !== undefined)
    .map((x) => `${x.lng!.toFixed(6)},${x.lat!.toFixed(6)}`);
  if (!points.length) return new Response("not found", { status: 404 });
  const url = new URL("https://restapi.amap.com/v3/staticmap");
  url.searchParams.set("key", key);
  url.searchParams.set("size", "750*420");
  url.searchParams.set("scale", "2");
  url.searchParams.set("markers", `mid,0x0F766E,:${points.slice(0, 20).join(";")}`);
  if (points.length > 1) url.searchParams.set("paths", `6,0x0F766E,0.8,,:${points.slice(0, 20).join(";")}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok || !res.headers.get("content-type")?.startsWith("image/")) return new Response("not found", { status: 404 });
  return new Response(await res.arrayBuffer(), {
    headers: { "Content-Type": res.headers.get("content-type")!, "Cache-Control": "private, max-age=3600" },
  });
}
