import { connection } from "next/server";
import { listConversations } from "@/lib/db";

// 首页对话的历史总表，新的在前
export async function GET() {
  await connection();
  return Response.json({ conversations: listConversations() });
}
