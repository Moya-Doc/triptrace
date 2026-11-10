import type { NextRequest } from "next/server";
import { cachedPlaceDetail } from "@/lib/places";

// 地点详情：单日详情里再次点击已选中的景点或餐厅时打开。数据全部来自高德。
// 高德的详情接口一次约 1 秒，地址、电话、营业时间很少变，所以在服务端缓存 24 小时（见 lib/places.ts）

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/place/[id]">) {
  const { id } = await ctx.params;
  try {
    const place = await cachedPlaceDetail(id);
    if (!place) return Response.json({ ok: false, error: "高德里没有查到这个地点" }, { status: 404 });
    return Response.json({ ok: true, place });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "查询失败" }, { status: 502 });
  }
}
