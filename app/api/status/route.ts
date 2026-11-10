import { connection } from "next/server";
import { countInspirationCards } from "@/lib/db";

// 配置自检：告诉界面哪些 Key 已经配好，不返回 Key 本身。

export async function GET() {
  await connection();
  let cards: number | null = null;
  try {
    cards = countInspirationCards();
  } catch {
    cards = null;
  }
  return Response.json({
    llm: Boolean(process.env.LLM_API_KEY),
    amapWebService: Boolean(process.env.AMAP_WEB_SERVICE_KEY),
    amapJs: Boolean(process.env.NEXT_PUBLIC_AMAP_JS_KEY && process.env.NEXT_PUBLIC_AMAP_SECURITY_CODE),
    inspirationCards: cards,
  });
}
