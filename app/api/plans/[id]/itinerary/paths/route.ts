import type { NextRequest } from "next/server";
import { getPlan } from "@/lib/db";
import { legPieces } from "@/lib/legs";

// 单日详情的地图：这一天每段同城交通按它的方式走的真实路径（步行、驾车按道路；公交地铁分段，带线路名）。
// 打开单日详情时按需查询，不存进行程；选交通方式时查过的路线已经在缓存里，不会重复请求高德。?day=0
export async function GET(request: NextRequest, ctx: RouteContext<"/api/plans/[id]/itinerary/paths">) {
  const { id } = await ctx.params;
  const plan = getPlan(Number(id));
  const day = plan?.state.itinerary?.days.find((d) => d.index === Number(request.nextUrl.searchParams.get("day")));
  if (!day) return Response.json({ ok: false, error: "找不到这一天" }, { status: 404 });
  const legs = day.items.filter((x) => x.kind === "transit" && x.local && x.endpoints);
  const found = await Promise.all(
    legs.map(async (x) => [x.title, await legPieces(x.endpoints!.from, x.endpoints!.to, x.mode ?? "drive", day.city)] as const),
  );
  return Response.json({ ok: true, paths: Object.fromEntries(found.filter(([, p]) => p && p.length)) });
}
