import { AmapError, geocode } from "@/lib/amap";
import { checkFeasibility } from "@/lib/feasibility";
import { getPlan, savePlan } from "@/lib/db";
import { ConfigError } from "@/lib/llm";
import { respond } from "@/lib/respond";
import { findCandidates } from "@/lib/search";
import type { Candidate, ChatRequest, ChatResponse, Constraints, GeoPoint, RoutePlan } from "@/lib/types";
import { normalizeConstraints, withDaysFromDates } from "@/lib/types";
import { understand } from "@/lib/understand";

// 规划内的对话接口：按工作流串起各个步骤。
// ① 理解（LLM）→ 定位参照城市 → ② 检索计算（代码 + 高德）→ ④ 表达（LLM）→ 保存规划
// 规划内的对话只属于这个规划：不读、也不写灵感池（2026-11-02 用户决定）。
// "只去成都吧""这次不想吃烤羊"是这一次的决定，写进长期记忆会造成记忆污染

export async function POST(request: Request) {
  let body: ChatRequest;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "请求格式不对" }, 400);
  }
  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const warnings: string[] = [];
  const planId = body.planId ?? null;
  if (planId === null) return json({ ok: false, error: "缺少规划编号" }, 400);

  try {
    // ① 理解。在路书上直接修改、或者刚从首页进入规划时，条件已经是现成的，跳过理解
    let constraints: Constraints;
    if ((body.edit || body.kickoff) && body.constraints) {
      constraints = withDaysFromDates(normalizeConstraints(body.constraints)!);
    } else {
      if (!lastUser?.content.trim()) return json({ ok: false, error: "请先说说你的想法" }, 400);
      constraints = await understand(messages, normalizeConstraints(body.constraints ?? null));
    }

    // 选目的地：车程以"从哪里出发"为准，其次是参照城市。可行性检查不需要参照点，地图上画路线
    let anchor: GeoPoint | null = null;
    if (constraints.intent === "choose_destination") {
      const maxDrive = constraints.soft.find((s) => s.type === "max_drive_time");
      const place = maxDrive?.from ?? constraints.anchor ?? constraints.origin ?? null;
      if (place) {
        try {
          const found = await geocode(place);
          if (found) anchor = { name: found.name, lng: found.lng, lat: found.lat };
          else warnings.push(`地图上没有找到"${place}"（目前只支持中国境内的地点）`);
        } catch (e) {
          warnings.push(errorText(e));
        }
      }
    }

    // ② 检索计算
    let candidates: Candidate[] = [];
    let route: RoutePlan | null = null;
    let searched = false;
    if (constraints.intent === "choose_destination" && constraints.hard.length && anchor) {
      try {
        candidates = await findCandidates(constraints, anchor);
        searched = true;
      } catch (e) {
        warnings.push(`地点检索失败：${errorText(e)}`);
      }
    }
    if (constraints.intent === "feasibility_check" && constraints.cities.length >= 1) {
      try {
        route = await checkFeasibility(constraints);
        if (route?.unresolved.length) {
          warnings.push(`地图上没有找到：${route.unresolved.join("、")}（目前只支持中国境内的地点）`);
        }
      } catch (e) {
        warnings.push(`交通时间计算失败：${errorText(e)}`);
      }
    }

    // ④ 表达
    const { reply, suggestions } =
      constraints.intent === "other"
        ? { reply: "我是旅行规划助手，说说你想去哪儿、想做什么吧。", suggestions: [] }
        : await respond({
            messages,
            constraints,
            candidates,
            searched,
            edit: body.edit,
            kickoff: body.kickoff ?? false,
            shortlist: body.shortlist ?? [],
            route,
            itineraryReady: Boolean(getPlan(planId)?.state.itinerary),
          });

    {
      savePlan(planId, {
        state: {
          messages: [...messages, { role: "assistant", content: reply }],
          constraints,
          anchor,
          candidates,
          route,
          shortlist: body.shortlist ?? [],
        },
      });
    }

    return json({ ok: true, reply, suggestions, constraints, anchor, candidates, route, planId, warnings });
  } catch (e) {
    return json({ ok: false, error: errorText(e) }, e instanceof ConfigError ? 503 : 502);
  }
}

function errorText(e: unknown): string {
  if (e instanceof ConfigError || e instanceof AmapError) return e.message;
  if (e instanceof Error && e.name === "TimeoutError") return "请求超时了，请稍后再试";
  return e instanceof Error ? e.message : "出了点问题，请稍后再试";
}

function json(body: ChatResponse, status = 200) {
  return Response.json(body, { status });
}
