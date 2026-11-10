import type { NextRequest } from "next/server";
import { getPlan } from "@/lib/db";
import { legOptions } from "@/lib/legs";
import { normalizeConstraints } from "@/lib/types";

// 地图上点了两个地点之间的连线：查这一段步行、公交地铁、打车（或自驾）各要多久。?day=0&title=A → B
export async function GET(request: NextRequest, ctx: RouteContext<"/api/plans/[id]/itinerary/leg">) {
  const { id } = await ctx.params;
  const plan = getPlan(Number(id));
  const day = plan?.state.itinerary?.days.find((d) => d.index === Number(request.nextUrl.searchParams.get("day")));
  const leg = day?.items.find((x) => x.kind === "transit" && x.title === request.nextUrl.searchParams.get("title"));
  if (!day || !leg?.endpoints) return Response.json({ ok: false, error: "找不到这一段路" }, { status: 404 });
  const transport = normalizeConstraints(plan!.state.constraints)?.slots.transport.value ?? null;
  const options = await legOptions(leg.endpoints.from, leg.endpoints.to, day.city, transport);
  return Response.json({ ok: true, options });
}
