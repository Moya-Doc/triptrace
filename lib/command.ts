import { searchInCity, type Poi } from "./amap";
import { findHotel, findRestaurant, relayoutDay } from "./itinerary";
import { chatJson, REPLY } from "./llm";
import { cleanSuggestions, SUGGESTION_RULE } from "./suggestions";
import { legMode, MODE_LABEL } from "./leg-format";
import { formatRanges } from "./hours";
import { isRestaurant, mealItem, mealSlot, venueOf } from "./meal";
import { dayLoad, dayWindow, toClock, toMinutes, transitHeavy } from "./load";
import type { ChatMessage, Itinerary, ItineraryDay, ItineraryItem } from "./types";

// 生成行程之后，左边对话里说的话直接操控右边的行程。分工和其他模块一样：
// 1. LLM 只做"听懂"：把一句话翻译成几个编辑操作（改时间、删、加、挪到另一天、改一天的活动时间段）
// 2. 代码执行操作：地点必须在行程里或者在高德里搜得到；车程、时间、负荷由代码重新计算
// 3. LLM 再根据执行结果说一两句话：改了什么、对后面有什么影响
// 改目的地、日期、天数这类整体变化，交给原来的流程：更新路书后重新生成行程
// 用户没有明确说要改、但很可能想改时（propose），先不动行程，在回复末尾问一句，并给出"好，改吧"之类的快捷回复

export type EditOp =
  // shift：推迟（正）/ 提前（负）多少分钟，新的开始时间由代码算
  | { op: "set_time"; day: number; title: string; start?: string; end?: string; minutes?: number; shift?: number }
  | { op: "remove"; day: number; title: string }
  | {
      op: "add";
      day: number;
      query: string;
      start?: string;
      minutes?: number;
      part?: "morning" | "afternoon" | "evening";
      // 加的是餐厅、这顿饭已经有了时，用户回答"替换原来的"还是"额外加一站"
      as?: "replace" | "extra";
    }
  | { op: "move"; day: number; title: string; to_day: number }
  | { op: "reorder"; day: number; titles: string[] }
  | { op: "set_window"; day: number; start: string; end: string }
  | { op: "change_stay"; day: number; query?: string }
  | { op: "change_venue"; day: number; title: string; query?: string }
  | { op: "unpin"; day: number; titles: string[] };

export type CommandKind = "edit" | "propose" | "replan" | "chat" | "undo";


const PARSE_PROMPT = `你是行程编辑器。用户已经有一份逐日行程，现在在对话里说了一句话。判断这句话属于哪一类，输出 JSON：
{"kind": "edit" | "propose" | "replan" | "chat" | "undo", "ops": [...], "proposal": "..."}

- undo：用户想撤销刚才的修改（"撤销""改回去""刚才那个不要了""还是原来的好"），不需要 ops

- edit：用户**明确**要求调整某一天的具体安排（时间、停留多久、删掉、加一个地方、换到另一天、换顺序、某天几点出门几点回来、换酒店、换餐厅）。
  用户在确认 TT 上一轮提出的修改（"好""改吧""可以""就这么办"）也算 edit，ops 就是 TT 提出的那个修改
- propose：用户没有明确说要改，但从话里看很可能想改（例如"第二天好累啊""这家酒店离得有点远""熊猫基地会不会太赶"）。
  在 proposal 里用一句话写出你建议的修改，例如"把熊猫基地挪到第三天"；同时在 ops 里写出这个建议对应的操作
  （这时还不执行，用户确认后系统直接执行这些操作，所以 ops 必须和 proposal 说的完全一致）
- replan：用户明确要求改变整体条件，需要重新生成行程（换目的地、加减城市、改日期或天数、换交通方式、改返程地点），或者确认了 TT 上一轮提出的这类改变
- chat：提问、闲聊，或者回答 TT 的问题但不涉及改动

ops 只在 kind 为 edit 时填写，day 是第几天（从 1 开始），title 必须是行程里已有条目的名字（照抄）：
- {"op":"set_time","day":2,"title":"成都武侯祠博物馆","start":"10:00","end":"14:00"}  固定开始时间和结束时间；只说停留多久就给 minutes，不给 start/end
- {"op":"set_time","day":2,"title":"晚餐","shift":30}  "推迟半小时""往后挪 20 分钟""提前一小时"：shift 是分钟数，推迟为正、提前为负，不给 start/end；停留时长不变
- {"op":"unpin","day":2,"titles":["午餐","锦里古街"]}  取消这些条目的固定时间，交给系统按顺序和路上时间自动排；titles 为空数组表示这一天全部取消
- {"op":"remove","day":2,"title":"锦里古街"}
- {"op":"add","day":3,"query":"杜甫草堂","start":"15:00","minutes":120}  query 是要在高德里搜的地名；start、minutes 可省略。
  用户只说了"上午 / 下午 / 晚上"、没说具体几点时，不要写 start，改写 "part":"morning" | "afternoon" | "evening"。
  加的如果是餐厅，系统会自动当作一顿饭；这顿饭已经有了时 TT 会问"替换原来的，还是额外加一站"——用户回答时，重新输出这个 add，带上 "as":"replace" 或 "as":"extra"
- {"op":"move","day":2,"title":"锦里古街","to_day":3}
- {"op":"reorder","day":2,"titles":["锦里古街","成都武侯祠博物馆"]}  这一天景点的新顺序
- {"op":"set_window","day":1,"start":"10:00","end":"22:00"}  这一天几点开始、几点结束
- {"op":"change_stay","day":1,"query":"亚朵"}  换这一天的住宿；用户指定了酒店名或品牌就填 query，否则省略（在附近另找一家）。连住几晚要换就每天各一个
- {"op":"change_venue","day":2,"title":"午餐","query":"火锅"}  换某一顿饭的餐厅；title 是"午餐""晚餐"这类条目名，query 是想吃的店名或菜系，可省略

规则：
- **每一项几点开始由系统计算**：上一项结束 + 两者之间的路上时间（行程里"路上"那几行）。你不需要、也不应该自己推算其他项的开始时间
- set_time 的 start / end **只用于用户亲口说出的时刻**（例如"10 点到 14 点"）。用户说"其余的你看着改""往后顺延""帮我理顺"时，不要给其他项写 start，
  而是用 reorder 调顺序、remove 删掉、set_time 只给 minutes 调停留时长；行程里标"固定"的条目不会自动顺延，挡住了后面的安排时用 unpin 取消它们的固定
- 改了一项的时间，排在它后面的（没有固定的）安排会自动顺延，不需要单独的操作
- "其余的往后推""其他的都排到它后面"：用户想让刚固定时间的那一项排在这一天的最前面，输出 reorder，它排第一，其余景点保持原来的先后
- 用户没说是哪一天时，从对话上下文推断；推断不出来就归为 chat
- 时间一律用 24 小时制 HH:MM，"下午两点"是 14:00
- 不要编造行程里没有的条目名
- 行程里标"⚠ 开放时间"的项，说明按现在的安排和开放时间对不上；用户让你"理顺 / 看着改"时，把它挪到开放时间内（调顺序、挪到另一天、缩短停留）`;

// context：额外的情境，例如旅行中"现在是第 2 天 14:20，刚到武侯祠；已经去过的不能动"
export async function parseCommand(messages: ChatMessage[], itinerary: Itinerary, context?: string) {
  const conversation = messages
    .slice(-4)
    .map((m) => `${m.role === "user" ? "用户" : "TT"}：${m.content}`)
    .join("\n");
  const raw = (await chatJson([
    { role: "system", content: PARSE_PROMPT },
    {
      role: "user",
      content: [context ? `情境：${context}` : "", `行程：\n${outline(itinerary)}`, `最近的对话：\n${conversation}`]
        .filter(Boolean)
        .join("\n\n"),
    },
  ])) as { kind?: unknown; ops?: unknown; proposal?: unknown };
  const kind: CommandKind =
    raw.kind === "edit" || raw.kind === "replan" || raw.kind === "propose" || raw.kind === "undo" ? raw.kind : "chat";
  const ops = Array.isArray(raw.ops) ? (raw.ops as EditOp[]).filter(validOp) : [];
  const proposal = typeof raw.proposal === "string" && raw.proposal.trim() ? raw.proposal.trim() : null;
  if (kind === "edit" && !ops.length) return { kind: "chat" as const, ops, proposal: null };
  if (kind === "propose" && !proposal) return { kind: "chat" as const, ops, proposal: null };
  return { kind, ops, proposal };
}

// 用户确认 TT 上一轮的提议（"好，改吧""可以""就这么办"）：直接执行提议时存下的操作，不再让 LLM 重新理解一遍，
// 免得执行的和提议的不一样。pending 是提议时存下的操作；没有或用户说的不是确认，就照常理解
const CONFIRM = /^(好|行|可以|改吧|改|就这么|没问题|ok|嗯|确认|按你说的|同意)/i;

export async function resolveCommand(
  messages: ChatMessage[],
  itinerary: Itinerary,
  pending: EditOp[] | undefined,
  context?: string,
) {
  // 旅行中的话前面带着"（第 2 天 14:40）"，判断是不是确认时去掉
  const last = ([...messages].reverse().find((m) => m.role === "user")?.content ?? "").replace(/^（第 \d+ 天 \d{2}:\d{2}）/, "").trim();
  if (pending?.length && last.length <= 12 && CONFIRM.test(last) && !/不/.test(last))
    return { kind: "edit" as const, ops: pending, proposal: null, confirmed: true };
  return { ...(await parseCommand(messages, itinerary, context)), confirmed: false };
}

// 提议之前先把操作试算一遍（不保存），用试算出的"会改成什么"来描述提议：
// 这样 TT 嘴上说的和用户确认后真正执行的，是同一份东西
export async function describeProposal(itinerary: Itinerary, ops: EditOp[], transport: string | null) {
  if (!ops.length) return null;
  const dry = await applyOps(itinerary, ops, transport);
  return dry.applied.length ? dry.applied.join("；") : null;
}

// 用户把上一句原样又发了一遍（连点了几次"下雨了"）：情况没变，回答也不会变，不再问模型，直接说一句。
// "好，改吧"这类确认不算（有待确认的修改时，它们走确认的流程）
export function repeatedMessage(messages: ChatMessage[], pending: EditOp[] | undefined) {
  const strip = (t: string) => t.replace(/^（第 \d+ 天 \d{2}:\d{2}）/, "").trim();
  const n = messages.length;
  if (n < 3 || messages[n - 1].role !== "user" || messages[n - 2].role !== "assistant" || messages[n - 3].role !== "user") return null;
  const text = strip(messages[n - 1].content);
  if (text !== strip(messages[n - 3].content) || CONFIRM.test(text)) return null;
  return pending?.length
    ? { reply: "这句刚才说过了，我的建议还是上面那条。要改就点「好，改吧」，不改就点「先不改」。", suggestions: ["好，改吧", "先不改"] }
    : { reply: "这句刚才说过了，我的回答还是上面那条。想换个思路可以直接说，比如「雨天附近有什么室内的地方」。", suggestions: [] };
}

// 同一个提议还在等用户确认、这次又要提一样的（比如连说了几次"下雨了"）：不再让 LLM 重写一遍（它会一字不差地重复），
// 直接提醒刚才的建议还在。操作比较时不看顺序
export function repeatedProposal(ops: EditOp[], pending: EditOp[] | undefined, exact: string | null) {
  if (!exact || !ops.length || !pending?.length || ops.length !== pending.length) return null;
  // LLM 写条目名时有时带餐厅名（"晚餐（某某店）"），有时不带：比较前去掉
  const key = (list: EditOp[]) =>
    list
      .map((o) => JSON.stringify("title" in o && typeof o.title === "string" ? { ...o, title: o.title.replace(/（.*）$/, "") } : o))
      .sort()
      .join("\n");
  if (key(ops) !== key(pending)) return null;
  return { reply: `刚才的建议还在：${exact}。要改就点「好，改吧」，不改就点「先不改」。`, suggestions: ["好，改吧", "先不改"] };
}

const CLOCK = /^\d{2}:\d{2}$/;

function validOp(o: EditOp) {
  if (!o || typeof o !== "object" || typeof o.day !== "number") return false;
  switch (o.op) {
    case "set_time":
      return (
        typeof o.title === "string" &&
        (o.start === undefined || CLOCK.test(o.start)) &&
        (o.end === undefined || CLOCK.test(o.end)) &&
        (o.shift === undefined || (typeof o.shift === "number" && o.shift !== 0 && Math.abs(o.shift) <= 360))
      );
    case "remove":
      return typeof o.title === "string";
    case "add":
      return (
        typeof o.query === "string" &&
        o.query.trim().length > 0 &&
        (o.start === undefined || CLOCK.test(o.start)) &&
        (o.part === undefined || ["morning", "afternoon", "evening"].includes(o.part)) &&
        (o.as === undefined || o.as === "replace" || o.as === "extra")
      );
    case "move":
      return typeof o.title === "string" && typeof o.to_day === "number";
    case "reorder":
      return Array.isArray(o.titles);
    case "set_window":
      return CLOCK.test(o.start) && CLOCK.test(o.end) && toMinutes(o.end) > toMinutes(o.start);
    case "unpin":
      return Array.isArray(o.titles);
    case "change_stay":
      return o.query === undefined || typeof o.query === "string";
    case "change_venue":
      return typeof o.title === "string" && (o.query === undefined || typeof o.query === "string");
    default:
      return false;
  }
}

// 执行编辑操作。每一天先收集改动，最后每天只重新排一次（重新查车程、排时间、判断负荷）
export async function applyOps(itinerary: Itinerary, ops: EditOp[], transport: string | null = null) {
  // 这一次新固定了时间的条目（"天|条目名"），排完后检查它们有没有漏算路上时间
  const pinnedNow = new Set<string>();
  const applied: string[] = [];
  // 需要用户决定的问题（例如加的餐厅是替换原来的午餐，还是额外加一站），TT 在回复末尾问
  const questions: { text: string; options: string[] }[] = [];
  const failed: string[] = [];
  const days = new Map(itinerary.days.map((d) => [d.index, { ...d }]));
  const orders = new Map<number, ItineraryItem[]>();
  const orderOf = (index: number) => {
    if (!orders.has(index)) {
      const d = days.get(index)!;
      orders.set(index, d.items.filter((x) => x.kind === "place" || x.kind === "free").map((x) => ({ ...x })));
    }
    return orders.get(index)!;
  };
  const find = (list: ItineraryItem[], title: string) =>
    list.find((x) => x.title === title) ?? list.find((x) => x.title.includes(title) || title.includes(x.title));

  for (const o of ops) {
    const index = o.day - 1;
    const day = days.get(index);
    if (!day) {
      failed.push(`没有第 ${o.day} 天`);
      continue;
    }
    const order = orderOf(index);
    if (o.op === "unpin") {
      const targets = o.titles.length
        ? o.titles.map((t) => find(order, t)).filter((x): x is ItineraryItem => Boolean(x))
        : order.filter((x) => x.pinned);
      for (const x of targets) x.pinned = false;
      if (targets.length)
        applied.push(`第 ${o.day} 天取消了${o.titles.length ? targets.map((x) => `"${x.title}"`).join("、") : "全部"}的固定时间，按顺序和路上时间重新排`);
    } else if (o.op === "change_stay") {
      const current = day.items.find((x) => x.kind === "stay");
      const lastPlace = [...order].reverse().find((x) => x.kind === "place" && x.lng !== undefined);
      const ref = current?.lng !== undefined ? current : lastPlace;
      const hotel = await findHotel({
        city: day.city,
        near: ref ? { name: ref.title, lng: ref.lng!, lat: ref.lat! } : null,
        query: o.query?.trim() || undefined,
        exclude: current?.placeId,
      });
      if (!hotel) {
        failed.push(`第 ${o.day} 天没找到${o.query ? `"${o.query}"这家` : "附近合适的"}住宿`);
        continue;
      }
      const items = current ? day.items.map((x) => (x === current ? hotel : x)) : [...day.items, hotel];
      days.set(index, { ...day, items });
      orderOf(index);
      applied.push(`第 ${o.day} 天的住宿换成了"${hotel.title}"`);
    } else if (o.op === "change_venue") {
      const item = find(order.filter((x) => x.kind === "free"), o.title);
      if (!item) {
        failed.push(`第 ${o.day} 天没有"${o.title}"`);
        continue;
      }
      const i = order.indexOf(item);
      const ref =
        [...order.slice(0, i)].reverse().find((x) => x.kind === "place" && x.lng !== undefined) ??
        order.slice(i + 1).find((x) => x.kind === "place" && x.lng !== undefined);
      const venue = await findRestaurant({
        near: ref ? { name: ref.title, lng: ref.lng!, lat: ref.lat! } : null,
        city: o.query?.trim() && !ref ? day.city : undefined,
        query: o.query?.trim() || undefined,
        exclude: item.venue?.placeId,
      });
      if (!venue) {
        failed.push(`没找到合适的${o.query ? `"${o.query}"` : ""}餐厅`);
        continue;
      }
      item.venue = venue;
      applied.push(`第 ${o.day} 天的${item.title}换成了"${venue.name}"`);
    } else if (o.op === "set_window") {
      days.set(index, { ...day, window: { start: o.start, end: o.end } });
      applied.push(`第 ${o.day} 天的活动时间改为 ${o.start}–${o.end}`);
    } else if (o.op === "set_time") {
      const item = find(order, o.title);
      if (!item) {
        failed.push(`第 ${o.day} 天没有"${o.title}"`);
        continue;
      }
      // 推迟 / 提前：在现在的开始时间上加减，开始时间由代码算，不让 LLM 推算
      const shifted = o.shift && !o.start && item.start ? toClock(toMinutes(item.start) + Math.round(o.shift)) : null;
      if (o.shift && !o.start && !item.start) {
        failed.push(`第 ${o.day} 天"${item.title}"还没排时间，没法推迟或提前`);
        continue;
      }
      const start = o.start ?? shifted;
      const before = { start: item.start, minutes: item.minutes, pinned: item.pinned };
      if (start) {
        item.start = start;
        item.pinned = true;
        pinnedNow.add(`${index}|${item.title}`);
        placeByTime(order, item);
      }
      const minutes =
        o.start && o.end ? toMinutes(o.end) - toMinutes(o.start) : typeof o.minutes === "number" ? Math.round(o.minutes) : null;
      if (minutes !== null && minutes >= 10 && minutes <= 720) item.minutes = minutes;
      // 什么都没变（例如 LLM 自己推算的时刻被 guardTimes 去掉了），不能说成"改了"
      if (item.start === before.start && item.minutes === before.minutes && item.pinned === before.pinned) {
        failed.push(`第 ${o.day} 天"${item.title}"的时间没有改：没听出要改成几点或推迟多久`);
        continue;
      }
      applied.push(
        shifted
          ? `第 ${o.day} 天"${item.title}"${o.shift! > 0 ? "推迟" : "提前"} ${Math.abs(Math.round(o.shift!))} 分钟，改为 ${shifted} 开始`
          : `第 ${o.day} 天"${item.title}"改为 ${start ? `${start} 开始，` : ""}停留 ${item.minutes} 分钟`,
      );
    } else if (o.op === "remove") {
      const item = find(order, o.title);
      if (!item) {
        failed.push(`第 ${o.day} 天没有"${o.title}"`);
        continue;
      }
      order.splice(order.indexOf(item), 1);
      applied.push(`第 ${o.day} 天删掉了"${item.title}"`);
    } else if (o.op === "add") {
      const same = (name: string) => name.includes(o.query) || o.query.includes(name);
      const elsewhere = itinerary.days.find((d) =>
        d.items.some((x) => (x.kind === "place" && same(x.title)) || (x.venue && same(x.venue.name))),
      );
      if (elsewhere) {
        failed.push(`"${o.query}"已经排在第 ${elsewhere.index + 1} 天了，要换过来可以说"挪到第 ${o.day} 天"`);
        continue;
      }
      const poi = await findPlace(o.query.trim(), day.city);
      if (!poi) {
        failed.push(`在${day.city}没有找到"${o.query}"`);
        continue;
      }
      // 餐厅：作为一顿饭加进来（规则见 lib/meal.ts）
      if (isRestaurant(poi.type)) {
        const spot = { id: poi.id, name: poi.name, photo: poi.photo, lng: poi.lng, lat: poi.lat };
        // 先按景点的规则找到插入位置，再判断这是午餐还是晚餐
        const probe = mealItem("午餐", spot);
        if (o.start) {
          probe.start = o.start;
          placeByTime(order, probe);
        } else if (o.part) insertByPart(order, probe, o.part);
        else insertPlace(order, probe);
        const at = order.indexOf(probe);
        order.splice(at, 1);
        // 用户说了时刻或"晚上 / 上午"就按用户的，否则看前一项几点结束
        const slot = o.start
          ? toMinutes(o.start) < 15 * 60
            ? "午餐"
            : "晚餐"
          : o.part === "evening"
            ? "晚餐"
            : o.part === "morning"
              ? "午餐"
              : mealSlot(order, at);
        const existing = order.find((x) => x.kind === "free" && x.title === slot);
        if (existing && !o.as) {
          questions.push({
            text: `第 ${o.day} 天已经有${slot}（${existing.venue?.name ?? slot}）：「${poi.name}」是替换原来的${slot}，还是额外加一站？`,
            options: [`替换原来的${slot}`, "额外加一站"],
          });
          continue;
        }
        if (existing && o.as === "replace") {
          existing.venue = venueOf(spot);
          applied.push(`第 ${o.day} 天的${slot}换成了"${poi.name}"`);
          continue;
        }
        const meal = mealItem(existing ? "加餐" : slot, spot);
        if (o.start) {
          meal.start = o.start;
          meal.pinned = true;
          pinnedNow.add(`${index}|${meal.title}`);
        }
        order.splice(at, 0, meal);
        applied.push(`第 ${o.day} 天加上了"${poi.name}"，算作${meal.title}`);
        continue;
      }
      const item: ItineraryItem = {
        kind: "place",
        title: poi.name,
        start: o.start ?? null,
        minutes: typeof o.minutes === "number" && o.minutes >= 10 && o.minutes <= 720 ? Math.round(o.minutes) : 120,
        via: null,
        placeId: poi.id,
        photo: poi.photo,
        verified: false,
        lng: poi.lng,
        lat: poi.lat,
        pinned: Boolean(o.start),
      };
      if (item.pinned) {
        // 新加的地点固定了时间，也参与"只差路上时间就顺延"的检查
        pinnedNow.add(`${index}|${item.title}`);
        placeByTime(order, item);
      }
      else if (o.part) insertByPart(order, item, o.part);
      else insertPlace(order, item);
      applied.push(`第 ${o.day} 天加上了"${poi.name}"`);
    } else if (o.op === "move") {
      const item = find(order, o.title);
      if (!item || !days.has(o.to_day - 1)) {
        failed.push(item ? `没有第 ${o.to_day} 天` : `第 ${o.day} 天没有"${o.title}"`);
        continue;
      }
      order.splice(order.indexOf(item), 1);
      insertPlace(orderOf(o.to_day - 1), { ...item, start: null, pinned: false });
      applied.push(`"${item.title}"从第 ${o.day} 天挪到了第 ${o.to_day} 天`);
    } else if (o.op === "reorder") {
      const places = o.titles.map((t) => find(order, t)).filter((x): x is ItineraryItem => Boolean(x));
      // 只调整景点之间的先后，用餐留在原来的位置上
      let k = 0;
      const next = order.map((x) => (x.kind === "place" && places.includes(x) ? places[k++] : x));
      if (k === places.length && places.length > 1) {
        order.splice(0, order.length, ...next);
        applied.push(`第 ${o.day} 天的顺序改为：${places.map((x) => x.title).join(" → ")}`);
      } else failed.push(`第 ${o.day} 天的顺序没能调整`);
    }
  }

  // 改了活动时间段、但条目没变的日子也要重新排
  const touched = new Set([...orders.keys(), ...ops.filter((o) => o.op === "set_window").map((o) => o.day - 1)]);
  for (const index of touched) {
    const day = days.get(index);
    if (!day) continue;
    let laid = await relayoutDay(day, orderOf(index), { transport });
    const intended = new Map<string, string>();
    // 兜底：新固定的时间如果只是没算路上的时间（开始时间不早于上一项结束，但早于"上一项结束 + 路上时间"），
    // 就取消固定、顺延到走过去之后；这一段被顺延了，后面同样是这次新固定的条目也一起顺延。
    // 真正和上一项重叠的（开始时间早于上一项结束）保留冲突，交给用户决定
    for (let guard = 0; guard < 12; guard++) {
      const fix = travelOnlyConflict(laid, (title) => pinnedNow.has(`${index}|${title}`), intended);
      if (!fix) break;
      pinnedNow.delete(`${index}|${fix.title}`);
      intended.set(fix.title, fix.start);
      const target = orderOf(index).find((x) => x.title === fix.title);
      if (target) target.pinned = false;
      laid = await relayoutDay(laid, orderOf(index), { transport });
      const now = laid.items.find((x) => x.title === fix.title);
      applied.push(`"${fix.title}"原定 ${fix.start}，加上路上的时间后顺延到 ${now?.start ?? "之后"}`);
    }
    days.set(index, laid);
  }
  return {
    itinerary: { ...itinerary, days: itinerary.days.map((d) => days.get(d.index) ?? d) },
    applied,
    failed,
    questions,
    changedDays: [...touched].sort((a, b) => a - b),
  };
}

// 在城市里搜要加的地点：跳过地铁站、公交站、停车场、出入口这类"同名但不是景点"的结果。
// 高德免费额度每秒请求数有限，失败时稍等再试一次
async function findPlace(query: string, city: string): Promise<Poi | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const found = await searchInCity([query], city, 10);
      return (
        found.find(
          (p) =>
            !/交通设施|停车场|公共厕所/.test(p.type) &&
            !/地铁站|公交站|停车场|出入口|[东西南北]门\)?$/.test(p.name) &&
            !/暂停营业|暂停开放|停业|已关闭/.test(p.name),
        ) ?? null
      );
    } catch (e) {
      console.warn(`[command] 搜索"${query}"失败：${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return null;
}

// 固定了开始时间的条目，挪到按时间该在的位置：排在第一个"原来开始得比它晚"的条目前面。
// 例如把武侯祠固定在 10:00，原来 11:30 的午餐就排到它后面去
function placeByTime(order: ItineraryItem[], item: ItineraryItem) {
  const t = toMinutes(item.start!);
  const rest = order.filter((x) => x !== item);
  const at = rest.findIndex((x) => x.start && toMinutes(x.start) >= t);
  order.splice(0, order.length, ...(at < 0 ? [...rest, item] : [...rest.slice(0, at), item, ...rest.slice(at)]));
}

// 只说了上午 / 下午 / 晚上：上午放在午餐之前，下午放在午餐之后，晚上放在晚餐之后（没有对应的饭就放在最前 / 最后）
function insertByPart(order: ItineraryItem[], item: ItineraryItem, part: "morning" | "afternoon" | "evening") {
  const lunch = order.findIndex((x) => x.kind === "free" && x.title === "午餐");
  const dinner = order.findIndex((x) => x.kind === "free" && x.title === "晚餐");
  const at =
    part === "morning"
      ? Math.max(0, lunch)
      : part === "afternoon"
        ? lunch >= 0
          ? lunch + 1
          : dinner >= 0
            ? dinner
            : order.length
        : dinner >= 0
          ? dinner + 1
          : order.length;
  order.splice(at, 0, item);
}

// 新景点放在这一天最后一个景点后面
function insertPlace(order: ItineraryItem[], item: ItineraryItem) {
  const last = order.map((x) => x.kind).lastIndexOf("place");
  order.splice(last + 1, 0, item);
}

const REPLY_PROMPT = `你是 TripTrace，旅行顾问。用户刚在对话里让你调整了行程，代码已经改好了。根据"执行结果"和"调整后的安排"回一句话，输出 JSON：{"reply": 回复内容, "suggestions": [...]}

- 第一句说清改了什么，带上具体时间（例如"武侯祠固定在 10:00–14:00"）
- 再说一句对后面的影响：顺延到几点、哪一项和前面冲突了、这一天是不是变满了（用"负荷"里的结论，不要自己算）
- failed 不为空时，直说哪一项没改成、为什么
- 调整后的安排里有"⚠ 开放时间"的项，要提醒用户（例如"熊猫基地 16:30 就关门，按现在只能待半小时"），并给一个具体的调整建议；没有标 ⚠ 的项不要提开放时间
- questions 不为空时，这些事需要用户决定：先说已经改了的，最后用 **加粗** 原样问出 questions 里的问题，不要替用户决定
- 最多问一个问题，只在确实需要用户决定时才问；不要把之前问过的问题再问一遍
- 不要复述之前说过的可行性结论和方案，用户已经看过了
- 40–120 字，口语化；只能用 **加粗**，不要用列表和标题
${SUGGESTION_RULE}`;

export async function replyToEdit(input: {
  messages: ChatMessage[];
  itinerary: Itinerary;
  applied: string[];
  failed: string[];
  questions: { text: string; options: string[] }[];
  changedDays: number[];
  context?: string;
}) {
  const { messages, itinerary, applied, failed, questions, changedDays, context } = input;
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const changed = itinerary.days.filter((d) => changedDays.includes(d.index));
  const raw = (await chatJson([
    { role: "system", content: REPLY_PROMPT },
    {
      role: "user",
      content: [
        context ? `情境：${context}` : "",
        `用户说：${lastUser}`,
        `执行结果：${JSON.stringify({ applied, failed, questions: questions.map((q) => q.text) })}`,
        `调整后的安排：\n${outline({ ...itinerary, days: changed })}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ], REPLY)) as { reply?: unknown; suggestions?: unknown };
  const reply =
    typeof raw.reply === "string" && raw.reply.trim()
      ? raw.reply.trim()
      : applied.length
        ? `改好了：${applied.join("；")}。`
        : `没改成：${failed.join("；")}。`;
  // 有待用户决定的问题时，快捷回复就是这个问题的选项
  const options = questions[0]?.options;
  // LLM 万一没把问题问出来，就补在最后，保证用户看得到要决定什么
  const text = questions.length && !/额外加一站/.test(reply) ? `${reply}\n\n**${questions[0].text}**` : reply;
  return { reply: text, suggestions: options ?? cleanSuggestions(raw.suggestions) };
}


// 给 LLM 看的行程概要：每天的活动时间段、每一项的起止时间和负荷
function outline(itinerary: Itinerary) {
  return itinerary.days.map(dayOutline).join("\n");
}

function marks(x: ItineraryItem) {
  return [
    x.done ? "（已去过）" : "",
    x.pinned && !x.done ? "（固定）" : "",
    x.conflict ? "（和前一项时间冲突）" : "",
    x.hours?.ranges ? `（开放 ${formatRanges(x.hours)}）` : "",
    x.hoursIssue ? `（⚠ 开放时间：${x.hoursIssue}）` : "",
  ].join("");
}

// 找第一个"只差路上时间"的冲突：它是这一次新固定的，开始时间不早于上一项（按原本打算的时间）结束。
// "原本打算的时间"：上一项如果刚被顺延过，就按它被顺延之前的开始时间算——
// 这样 TT 一口气排的"14:00 午餐、14:30 锦里、17:30 陈麻婆"会整串顺延，而用户真的排重叠了的仍然标冲突
function travelOnlyConflict(day: ItineraryDay, isNew: (title: string) => boolean, intended: Map<string, string>) {
  let prevEnd: number | null = null;
  for (const x of day.items) {
    if (x.kind === "transit" || x.kind === "stay" || !x.start) continue;
    const start = toMinutes(x.start);
    if (x.conflict && x.pinned && isNew(x.title) && (prevEnd === null || start >= prevEnd))
      return { title: x.title, start: x.start };
    const planned = intended.get(x.title);
    prevEnd = (planned ? toMinutes(planned) : start) + x.minutes;
  }
  return null;
}

function dayOutline(d: ItineraryDay) {
  const w = dayWindow(d);
  const load = dayLoad(d.transitMinutes, d.playMinutes, w.minutes);
  const loadText = { ok: "刚好", tight: "偏紧", overloaded: "太满" }[load] + (transitHeavy(d.transitMinutes, w.minutes) ? "，路上久" : "");
  const items = d.items.map((x) => {
      if (x.kind === "transit" && x.local) return `  · 　路上：${MODE_LABEL[legMode(x)]} ${x.minutes} 分钟`;
      if (x.kind === "transit") return `  · ${x.title}（${x.via ?? "交通"}，${x.minutes} 分钟）`;
      if (x.kind === "stay") return `  · 住宿：${x.title}`;
      if (x.venue) {
        const range = x.start ? `${x.start}–${toClock(toMinutes(x.start) + x.minutes)}` : "时间未定";
        return `  · ${range} ${x.title}（${x.venue.name}）${marks(x)}`;
      }
      const range = x.start ? `${x.start}–${toClock(toMinutes(x.start) + x.minutes)}` : "时间未定";
      return `  · ${range} ${x.title}${marks(x)}`;
    });
  return `第 ${d.index + 1} 天 ${d.date ?? ""} ${d.city}，活动时间 ${w.start}–${w.end}，负荷：${loadText}\n${items.join("\n")}`;
}

const ANSWER_PROMPT = `你是 TripTrace，旅行顾问。用户已经有一份逐日行程（见"当前行程"），现在在对话里问了一个问题或者随口说了一句。输出 JSON：{"reply": 回复内容, "suggestions": [...]}

- 直接回答，答案只能来自"当前行程"里的时间和地点，不要编造
- 有"建议的修改"时：先回应用户这句话，再说你建议怎么改、改了有什么好处，最后问一句"要不要我这样改？"。这时还没有改，不要说"已经改好了"。
  建议的内容**照"建议的修改"说，不要增加、减少或改动其中的地点和时间**——用户确认后系统会原样执行它
- 不要复述之前说过的可行性结论、方案 A/B/C 和提醒，用户已经看过了；之前问过、用户没回答的问题不要再问
- 如果用户像是想调整行程但没说清楚（比如没说是哪一天），问一句确认
- 30–120 字，口语化；只能用 **加粗**，不要用列表和标题
${SUGGESTION_RULE}`;

// 生成行程之后的提问和闲聊：基于当前行程回答，不再走可行性检查的流程，避免把之前的结论重复一遍
export async function answerAboutItinerary(
  messages: ChatMessage[],
  itinerary: Itinerary,
  proposal: string | null,
  context?: string,
) {
  const conversation = messages
    .slice(-6)
    .map((m) => `${m.role === "user" ? "用户" : "TT"}：${m.content}`)
    .join("\n");
  const raw = (await chatJson([
    { role: "system", content: ANSWER_PROMPT },
    {
      role: "user",
      content: [
        context ? `情境：${context}` : "",
        `当前行程：\n${outline(itinerary)}`,
        `对话记录：\n${conversation}`,
        proposal ? `建议的修改（还没有执行）：${proposal}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ], REPLY)) as { reply?: unknown; suggestions?: unknown };
  if (typeof raw.reply !== "string" || !raw.reply.trim()) throw new Error("回复生成失败，请再试一次");
  const suggestions = cleanSuggestions(raw.suggestions);
  // 提议修改时，前两条快捷回复一定是"改 / 不改"
  return {
    reply: raw.reply.trim(),
    suggestions: proposal ? ["好，改吧", "先不改", ...suggestions.filter((x) => !/改/.test(x))].slice(0, 3) : suggestions,
  };
}

// ---------- 固定时间的核对（规则，不靠 LLM） ----------
// 只有用户亲口说出的时刻才能被固定。从用户这句话（以及用户刚确认的 TT 上一条提议）里认出所有时刻，
// LLM 给出的 start / end 不在其中的，一律去掉：这一项交给系统按顺序和路上时间排，不会被凭空钉死

const CN_NUM: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnNumber(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  if (text === "十") return 10;
  const m = text.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0);
  return text.length === 1 && text in CN_NUM ? CN_NUM[text] : null;
}

export function mentionedTimes(texts: string[]): Set<number> {
  const out = new Set<number>();
  const add = (h: number, m: number, period: string | undefined) => {
    if (h > 24 || m > 59) return;
    if (period && /下午|傍晚|晚上|夜/.test(period) && h < 12) out.add((h + 12) * 60 + m);
    else if (period && /中午/.test(period) && h < 6) out.add((h + 12) * 60 + m);
    else if (period) out.add(h * 60 + m);
    else {
      // 没说上午下午："2 点"既可能是 2:00 也可能是 14:00，两个都算用户说过
      out.add(h * 60 + m);
      if (h < 12) out.add((h + 12) * 60 + m);
    }
  };
  for (const text of texts) {
    for (const m of text.matchAll(/(上午|早上|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2})[:：](\d{2})/g))
      add(Number(m[2]), Number(m[3]), m[1]);
    for (const m of text.matchAll(
      /(上午|早上|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*点\s*(半|一刻|三刻|(\d{1,2})\s*分?)?/g,
    )) {
      const h = cnNumber(m[2]);
      if (h === null) continue;
      const min = m[3] === "半" ? 30 : m[3] === "一刻" ? 15 : m[3] === "三刻" ? 45 : m[4] ? Number(m[4]) : 0;
      add(h, min, m[1]);
    }
  }
  return out;
}

export function guardTimes(ops: EditOp[], messages: ChatMessage[]) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const i = messages.map((m) => m.role).lastIndexOf("user");
  const prevTT = messages
    .slice(0, i)
    .reverse()
    .find((m) => m.role === "assistant")?.content ?? "";
  const said = mentionedTimes([lastUser, prevTT]);
  const ok = (t: string | undefined) => t !== undefined && said.has(toMinutes(t));
  return ops.map((o) => {
    if (o.op === "set_time") {
      // 说的是推迟 / 提前多久：开始时间交给代码算，LLM 顺手写的 start 不要
      if (o.shift) return { ...o, start: undefined, end: undefined };
      const start = ok(o.start) ? o.start : undefined;
      const end = start && ok(o.end) ? o.end : undefined;
      return { ...o, start, end, minutes: o.minutes };
    }
    if (o.op === "add" && o.start && !ok(o.start)) return { ...o, start: undefined };
    return o;
  });
}
