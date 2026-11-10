import type { NextRequest } from "next/server";
import { AmapError } from "@/lib/amap";
import { getPlan, saveItinerary } from "@/lib/db";
import { generateItinerary, relayoutDay } from "@/lib/itinerary";
import { ConfigError } from "@/lib/llm";
import { dayLoad, dayWindow, transitHeavy } from "@/lib/load";
import { normalizeConstraints, type Itinerary, type ItineraryItem, type LegMode, type Venue } from "@/lib/types";

// "生成规划"：用路书和地图结果生成逐日行程，并存进规划
export async function POST(_req: NextRequest, ctx: RouteContext<"/api/plans/[id]/itinerary">) {
  const { id } = await ctx.params;
  const planId = Number(id);
  const plan = getPlan(planId);
  if (!plan) return Response.json({ ok: false, error: "这个规划不存在" }, { status: 404 });
  const constraints = normalizeConstraints(plan.state.constraints);
  if (!constraints) return Response.json({ ok: false, error: "路书还是空的" }, { status: 400 });

  try {
    const generated = await generateItinerary({
      constraints,
      candidates: plan.state.candidates ?? [],
      shortlist: plan.state.shortlist ?? [],
      route: plan.state.route ?? null,
    });
    // 重新生成时保留用户已经标记完成的日子（按日期对应）
    const doneDates = new Set((plan.state.itinerary?.days ?? []).filter((d) => d.done).map((d) => d.date));
    const itinerary = {
      ...generated,
      days: generated.days.map((d) => ({ ...d, done: doneDates.has(d.date) })),
    };
    // TT 用一句话说明结果。结论由代码根据负荷算出来，不需要再调用一次大模型
    const message = { role: "assistant" as const, content: summarize(itinerary) };
    // 重新生成也能撤销（第一次生成没有可以回到的行程）
    const undo = saveItinerary(planId, itinerary, plan.state.itinerary ? "重新生成行程" : null, {
      messages: [...(plan.state.messages ?? []), message],
    });
    return Response.json({ ok: true, itinerary, message, undo });
  } catch (e) {
    const message =
      e instanceof ConfigError || e instanceof AmapError || e instanceof Error ? e.message : "生成失败，请再试一次";
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}

// 修改某一天：拖动调整顺序、删除景点、添加景点、手动改时间，都通过这个接口。
// order 是这一天的景点和用餐（不含交通和住宿）修改后的完整列表：
// - 原有条目按名称逐个配对，只接受用户能改的字段（开始时间、停留时长）
// - 列表里没有的原有条目视为删除
// - 新景点必须带高德的地点 id 和坐标（来自"添加景点"或"替换"的候选接口），替换时保留原来的开始时间和停留时长
// - 用餐可以换餐厅（venue 来自"替换"的候选接口）；也可以新加一顿（午餐 / 晚餐 / 加餐，必须带餐厅）
// - legs：用户在地图上点连线改的交通方式，{ "A → B": "walk" | "transit" | "taxi" | "drive" }
export async function PUT(request: NextRequest, ctx: RouteContext<"/api/plans/[id]/itinerary">) {
  const { id } = await ctx.params;
  const planId = Number(id);
  const plan = getPlan(planId);
  const itinerary = plan?.state.itinerary;
  if (!plan || !itinerary) return Response.json({ ok: false, error: "还没有生成行程" }, { status: 404 });
  const body = (await request.json()) as {
    dayIndex: number;
    order: ItineraryItem[];
    legs?: Record<string, LegMode>;
    // 这次修改做了什么（撤销时显示）；null 表示系统自己的整理（补全旧格式），不进历史
    label?: string | null;
    // 这一天的活动时间段（规划页城市名后面的时间，可以直接改）
    window?: { start: string; end: string };
    // 换住宿：来自"替换"的酒店候选（高德的地点 id 和坐标）
    stay?: { id: string; name: string; photo: string | null; lng: number; lat: number; district?: string };
  };
  const found = itinerary.days.find((d) => d.index === body.dayIndex);
  if (!found || !Array.isArray(body.order)) {
    return Response.json({ ok: false, error: "请求格式不对" }, { status: 400 });
  }
  let day = found;
  const clock = /^\d{2}:\d{2}$/;
  if (body.window && clock.test(body.window.start) && clock.test(body.window.end) && body.window.end > body.window.start)
    day = { ...day, window: { start: body.window.start, end: body.window.end } };
  const s = body.stay;
  if (s && typeof s.id === "string" && typeof s.name === "string" && typeof s.lng === "number" && typeof s.lat === "number") {
    const hotel: ItineraryItem = {
      kind: "stay",
      title: s.name.slice(0, 60),
      start: null,
      minutes: 0,
      via: s.district ?? null,
      placeId: s.id,
      photo: typeof s.photo === "string" ? s.photo : null,
      verified: true,
      lng: s.lng,
      lat: s.lat,
    };
    const hasStay = day.items.some((x) => x.kind === "stay");
    day = { ...day, items: hasStay ? day.items.map((x) => (x.kind === "stay" ? hotel : x)) : [...day.items, hotel] };
  }
  const pool = day.items.filter((x) => x.kind === "place" || x.kind === "free");
  const order: ItineraryItem[] = [];
  for (const x of body.order) {
    const i = pool.findIndex((o) => o.title === x.title && o.kind === x.kind);
    if (i >= 0) {
      const own = pool.splice(i, 1)[0];
      const pinned = Boolean(x.pinned && typeof x.start === "string" && /^\d{2}:\d{2}$/.test(x.start));
      // 停留时长：单日详情里改结束时间时会带上
      const minutes = validMinutes(x.minutes) ? x.minutes : own.minutes;
      const venue = own.kind === "free" && validVenue(x.venue) ? x.venue : own.venue;
      order.push({ ...own, pinned, minutes, venue, start: pinned ? x.start : own.start });
    } else if (x.kind === "free" && /^(午餐|晚餐|加餐)$/.test(x.title) && validVenue(x.venue)) {
      // 新加的一顿饭（"+ 用餐"，或在"+ 景点"里加了餐厅）：必须带高德的餐厅
      order.push({
        kind: "free",
        title: x.title,
        start: null,
        minutes: validMinutes(x.minutes) ? x.minutes : 60,
        via: null,
        placeId: null,
        photo: null,
        verified: false,
        venue: x.venue,
      });
    } else if (x.kind === "place" && x.placeId && typeof x.lng === "number" && typeof x.lat === "number") {
      const pinned = Boolean(x.pinned && typeof x.start === "string" && /^\d{2}:\d{2}$/.test(x.start));
      order.push({
        kind: "place",
        title: String(x.title).slice(0, 60),
        start: pinned ? x.start : null,
        pinned,
        minutes: validMinutes(x.minutes) ? x.minutes : 120,
        via: null,
        placeId: x.placeId,
        photo: typeof x.photo === "string" ? x.photo : null,
        verified: false,
        lng: x.lng,
        lat: x.lat,
      });
    }
  }

  try {
    const modes = ["walk", "transit", "taxi", "drive"];
    const legModes = Object.fromEntries(
      Object.entries(body.legs ?? {}).filter(([, m]) => modes.includes(m)),
    ) as Record<string, LegMode>;
    const transport = normalizeConstraints(plan.state.constraints)?.slots.transport.value ?? null;
    const updated = await relayoutDay(day, order, { transport, legModes });
    const next = { ...itinerary, days: itinerary.days.map((d) => (d.index === day.index ? updated : d)) };
    const label = body.label === null ? null : typeof body.label === "string" && body.label ? body.label : `修改了第 ${day.index + 1} 天`;
    const undo = saveItinerary(planId, next, label);
    return Response.json({ ok: true, itinerary: next, undo });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "调整失败" }, { status: 502 });
  }
}

// 负荷的判断和右边的负荷条用同一套规则（lib/load.ts）
function validMinutes(m: unknown): m is number {
  return Number.isInteger(m) && (m as number) >= 10 && (m as number) <= 720;
}

function validVenue(v: unknown): v is Venue {
  const x = v as Venue | null;
  return Boolean(x && typeof x.name === "string" && typeof x.placeId === "string" && typeof x.lng === "number" && typeof x.lat === "number");
}

function summarize(it: Itinerary) {
  const load = (d: Itinerary["days"][number]) => dayLoad(d.transitMinutes, d.playMinutes, dayWindow(d).minutes);
  const days = (list: Itinerary["days"]) => list.map((d) => d.index + 1).join("、");
  const full = it.days.filter((d) => load(d) === "overloaded");
  const tight = it.days.filter((d) => load(d) === "tight");
  const longRoad = it.days.filter((d) => transitHeavy(d.transitMinutes, dayWindow(d).minutes));
  const lines = [`逐日行程排好了：${it.title}，共 ${it.days.length} 天，在右边的"行程"里。`];
  if (full.length) lines.push(`第 ${days(full)} 天排得太满了，超出了当天的活动时间，建议删掉一项。`);
  else if (tight.length) lines.push(`第 ${days(tight)} 天排得比较满，其他几天还有空余。`);
  else lines.push("每天都还有空余时间，节奏比较松。");
  if (longRoad.length) {
    const longest = Math.max(...longRoad.map((d) => d.transitMinutes));
    lines.push(
      `第 ${days(longRoad)} 天路上时间比较长（最多 ${Math.floor(longest / 60)} 小时${longest % 60 ? ` ${longest % 60} 分` : ""}），这几天别再往远处安排。`,
    );
  }
  // 开放时间对不上的项（数据来自高德，规则核对）
  const hoursIssues = it.days.flatMap((d) =>
    d.items.filter((x) => x.hoursIssue).map((x) => `第 ${d.index + 1} 天${x.venue ? `${x.title}（${x.venue.name}）` : `「${x.title}」`}：${x.hoursIssue}`),
  );
  if (hoursIssues.length)
    lines.push(`\n按高德的开放时间核对，有 ${hoursIssues.length} 处对不上：\n\n${hoursIssues.map((t) => `- ${t}`).join("\n")}\n`);
  lines.push("地点和车程来自高德，停留多久是我的建议。想调整的话，直接在左边告诉我，比如\"第二天武侯祠改到 10 点到 14 点\"。");
  return lines.join("\n");
}
