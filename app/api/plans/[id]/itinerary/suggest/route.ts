import type { NextRequest } from "next/server";
import { getPlan } from "@/lib/db";
import { nearbyHotels, nearbyRestaurants, suggestPlaces } from "@/lib/itinerary";
import { normalizeConstraints } from "@/lib/types";

// "添加景点"和"替换"的候选：?day=第几天（从 0 开始）&q=关键词（可选）
// &meal=午餐：换餐厅的候选，在这顿饭附近（或在城市里按关键词）找
// &food=1："+ 用餐"新加一顿的候选，在这一天最后一个地点附近找
export async function GET(request: NextRequest, ctx: RouteContext<"/api/plans/[id]/itinerary/suggest">) {
  const { id } = await ctx.params;
  const plan = getPlan(Number(id));
  const day = plan?.state.itinerary?.days.find((d) => d.index === Number(request.nextUrl.searchParams.get("day")));
  const constraints = normalizeConstraints(plan?.state.constraints ?? null);
  if (!day || !constraints) return Response.json({ ok: false, error: "找不到这一天" }, { status: 404 });
  try {
    // 已经在行程里的地点和餐厅不再推荐
    const used = new Set(
      plan!.state.itinerary!.days.flatMap((d) => d.items.flatMap((x) => [x.placeId, x.venue?.placeId])).filter(Boolean),
    );
    // &hotel=1：换住宿的候选，在现在的住处附近（或在城市里按关键词）找
    if (request.nextUrl.searchParams.get("hotel")) {
      const items = await nearbyHotels(day, request.nextUrl.searchParams.get("q") ?? "");
      return Response.json({ ok: true, items: items.filter((p) => !used.has(p.id)) });
    }
    const meal = request.nextUrl.searchParams.get("meal");
    if (meal || request.nextUrl.searchParams.get("food")) {
      const items = await nearbyRestaurants(day, meal || null, request.nextUrl.searchParams.get("q") ?? "");
      return Response.json({ ok: true, items: items.filter((p) => !used.has(p.id)) });
    }
    const items = await suggestPlaces(day.city, request.nextUrl.searchParams.get("q") ?? "", constraints);
    return Response.json({ ok: true, items: items.filter((p) => !used.has(p.id)) });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "查询失败" }, { status: 502 });
  }
}
