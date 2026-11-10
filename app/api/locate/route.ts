import type { NextRequest } from "next/server";
import { cityAt } from "@/lib/amap";

// 当前所在地：浏览器给出坐标，这里换算成城市名。境外或查不到时返回 null，前端让用户自己填
export async function GET(request: NextRequest) {
  const lng = Number(request.nextUrl.searchParams.get("lng"));
  const lat = Number(request.nextUrl.searchParams.get("lat"));
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return Response.json({ city: null }, { status: 400 });
  }
  try {
    return Response.json({ city: await cityAt(lng, lat) });
  } catch {
    return Response.json({ city: null });
  }
}
