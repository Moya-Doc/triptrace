"use client";

import { useState } from "react";
import type { Constraints } from "@/lib/types";

// 路书页：一份可以直接修改的表单。
// 出发地 / 目的地 / 额外需求这类需要"理解"的字段，修改后交给 TT（发一条消息）；
// 日期、交通、住宿、同行人、预算这类结构化字段，直接改、直接保存。

export type LocateState = "idle" | "locating" | "failed";

type SlotKey = "transport" | "lodging" | "companions" | "budget";

type Props = {
  constraints: Constraints;
  locate: LocateState;
  busy: boolean;
  onAskTT: (text: string) => void;
  onDates: (start: string | null, end: string | null) => void;
  onSlot: (key: SlotKey, value: string | null) => void;
  onRemove: (kind: "hard" | "soft", index: number) => void;
  onLocate: () => void;
  hasItinerary: boolean;
  generating: boolean;
  onGenerate: () => void;
};

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function destinationText(c: Constraints) {
  return c.anchor ? `${c.anchor}周边` : c.cities.join("、");
}

// 生成规划的必要信息：目的地 + 结束日期（开始日期默认今天）
export function missingRequired(c: Constraints) {
  return [!destinationText(c) && "目的地", !c.end_date && "结束日期"].filter(
    Boolean,
  ) as string[];
}

export default function RoadbookView(props: Props) {
  const {
    constraints: c,
    locate,
    busy,
    onAskTT,
    onDates,
    onSlot,
    onRemove,
    onLocate,
  } = props;
  const { hasItinerary, generating, onGenerate } = props;
  const start = c.start_date ?? today();
  const missing = missingRequired(c);
  const unverifiable = c.soft.filter((s) => s.type === "preference");

  return (
    <div className="h-full overflow-y-auto bg-[#f4f3ef]">
      <div className="mx-auto max-w-lg space-y-6 px-6 pb-12 pt-20">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold">路书</h2>
          <span
            className={`text-xs ${missing.length ? "text-amber-700" : "text-teal-700"}`}
          >
            {missing.length ? `还差：${missing.join("、")}` : "必要信息已齐"}
          </span>
        </div>

        <Card>
          <Row label="出发地">
            <TextField
              value={c.origin ?? ""}
              placeholder={
                locate === "locating" ? "正在获取当前位置…" : "当前所在地"
              }
              disabled={busy}
              onCommit={(v) => onAskTT(`出发地改为${v}`)}
            />
            <button
              onClick={onLocate}
              disabled={locate === "locating"}
              className="shrink-0 text-xs text-teal-700 hover:underline disabled:text-gray-400"
            >
              定位
            </button>
          </Row>
          {locate === "failed" && !c.origin && (
            <p className="-mt-1 pb-2 pl-20 text-xs text-gray-400">
              没能定位到国内的城市（地图服务只覆盖中国境内），请手动填写
            </p>
          )}
          <Row label="目的地">
            <TextField
              value={destinationText(c)}
              placeholder="比如：成都周边，或 重庆、成都、西安"
              disabled={busy}
              onCommit={(v) => onAskTT(`目的地改为${v}`)}
            />
          </Row>
          <Row label="开始日期">
            <input
              type="date"
              value={start}
              onChange={(e) => onDates(e.target.value || null, c.end_date)}
              className="flex-1 bg-transparent text-sm outline-none"
            />
            {!c.start_date && (
              <span className="text-[11px] text-gray-400">默认今天</span>
            )}
          </Row>
          <Row label="结束日期">
            <input
              type="date"
              value={c.end_date ?? ""}
              min={start}
              onChange={(e) =>
                onDates(c.start_date ?? start, e.target.value || null)
              }
              // Safari 会把空的日期框显示成今天的日期，看起来像已经填了。
              // 没填时把日期文字设为透明，叠一行"选择结束日期"的提示
              className={`flex-1 bg-transparent text-sm outline-none ${c.end_date ? "" : "text-transparent focus:text-gray-900"}`}
            />
            {!c.end_date && (
              <span className="pointer-events-none absolute left-[4.75rem] text-sm text-amber-700">
                选择结束日期
              </span>
            )}
            {c.days && c.end_date ? (
              <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs text-teal-800">
                共 {c.days} 天
              </span>
            ) : null}
          </Row>
        </Card>

        <Section title="偏好设置" hint="可选">
          <Card>
            <Row label="交通方式">
              <select
                value={c.slots.transport.value ?? ""}
                onChange={(e) => onSlot("transport", e.target.value || null)}
                className="flex-1 bg-transparent text-sm outline-none"
              >
                <option value="">不限</option>
                {["自驾", "公共交通", "飞机"].map((o) => (
                  <option key={o}>{o}</option>
                ))}
                {c.slots.transport.value &&
                  !["自驾", "公共交通", "飞机"].includes(
                    c.slots.transport.value,
                  ) && <option>{c.slots.transport.value}</option>}
              </select>
              <SourceTag source={c.slots.transport.source} />
            </Row>
            <SlotRow
              label="住宿偏好"
              slotKey="lodging"
              c={c}
              placeholder="比如：露营、民宿"
              onSlot={onSlot}
            />
            <SlotRow
              label="同行人"
              slotKey="companions"
              c={c}
              placeholder="比如：爸妈、两个朋友"
              onSlot={onSlot}
            />
            <SlotRow
              label="预算"
              slotKey="budget"
              c={c}
              placeholder="比如：人均 1500"
              onSlot={onSlot}
            />
            <Row label="旅行偏好">
              <div className="flex flex-1 flex-wrap gap-1.5 py-1">
                {c.hard.map((h, i) => (
                  <Chip
                    key={`h${i}`}
                    label={h.label}
                    kind="hard"
                    onRemove={() => onRemove("hard", i)}
                  />
                ))}
                {c.soft.map((s, i) => (
                  <Chip
                    key={`s${i}`}
                    label={s.label}
                    kind={s.type === "preference" ? "unverifiable" : "soft"}
                    onRemove={() => onRemove("soft", i)}
                  />
                ))}
                {!c.hard.length && !c.soft.length && (
                  <span className="text-sm text-gray-400">
                    在对话里告诉 TT，比如“想露营，最好能吃烤全羊”
                  </span>
                )}
              </div>
            </Row>
          </Card>
          {unverifiable.length > 0 && (
            <p className="mt-2 text-xs text-gray-500">
              ◌ 暂无数据验证：{unverifiable.map((s) => s.label).join("、")}
            </p>
          )}
        </Section>

        <Section title="额外需求" hint="可选">
          <Card>
            <div className="py-2">
              <TextField
                value={c.extra ?? ""}
                placeholder="比如：想避开爬山太多的路线"
                disabled={busy}
                onCommit={(v) => onAskTT(`额外需求：${v}`)}
              />
            </div>
          </Card>
        </Section>

        {/* 必要信息（目的地 + 日期）齐了才出现；TT 也可以继续在对话里追问 */}
        {missing.length === 0 && (
          <button
            onClick={onGenerate}
            disabled={generating || busy}
            className="w-full rounded-xl bg-gray-900 py-3 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {generating
              ? "正在生成逐日行程，约 1 分钟…"
              : hasItinerary
                ? "按当前路书重新生成"
                : "生成规划"}
          </button>
        )}

        {c.memory_used.length > 0 && (
          <div className="rounded-xl bg-violet-50 px-4 py-3 text-sm text-violet-900">
            <div className="text-xs text-violet-700">从灵感池里想起了</div>
            <ul className="mt-1 space-y-1">
              {c.memory_used.map((m) => (
                <li key={m}>· {m}</li>
              ))}
            </ul>
          </div>
        )}
        {c.conflicts.map((x) => (
          <p key={x} className="text-sm text-amber-800">
            ⚠️ {x}
          </p>
        ))}
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-gray-700">
        {title} <span className="font-normal text-gray-400">· {hint}</span>
      </h3>
      {children}
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-gray-100 rounded-xl bg-white px-4">
      {children}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-11 items-center gap-3 py-1.5">
      <span className="w-16 shrink-0 text-sm text-gray-500">{label}</span>
      {children}
    </div>
  );
}

function SlotRow(props: {
  label: string;
  slotKey: SlotKey;
  c: Constraints;
  placeholder: string;
  onSlot: (key: SlotKey, value: string | null) => void;
}) {
  const slot = props.c.slots[props.slotKey];
  return (
    <Row label={props.label}>
      <TextField
        value={slot.value ?? ""}
        placeholder={props.placeholder}
        onCommit={(v) => props.onSlot(props.slotKey, v || null)}
        allowEmpty
      />
      <SourceTag source={slot.source} />
    </Row>
  );
}

// 来源标签：TT 的假设是蓝色，来自灵感池的记忆是紫色；用户自己填的不加标签
function SourceTag({
  source,
}: {
  source: "user" | "assumed" | "memory" | null;
}) {
  if (source === "assumed")
    return (
      <span className="shrink-0 rounded-full bg-sky-50 px-1.5 text-[11px] text-sky-700">
        TT 的假设
      </span>
    );
  if (source === "memory")
    return (
      <span className="shrink-0 rounded-full bg-violet-50 px-1.5 text-[11px] text-violet-700">
        来自记忆
      </span>
    );
  return null;
}

// 文本框：失去焦点或按回车时才提交，并且只有内容真的变了才提交
function TextField(props: {
  value: string;
  placeholder: string;
  disabled?: boolean;
  allowEmpty?: boolean;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  // 外部的值变了（比如 TT 改了路书），草稿跟着更新。React 推荐在渲染时这样做，而不是用 effect
  const [prev, setPrev] = useState(props.value);
  if (props.value !== prev) {
    setPrev(props.value);
    setDraft(props.value);
  }
  const commit = () => {
    const v = draft.trim();
    if (v === props.value.trim() || (!v && !props.allowEmpty)) {
      setDraft(props.value);
      return;
    }
    props.onCommit(v);
  };
  return (
    <input
      value={draft}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) =>
        e.key === "Enter" && (e.target as HTMLInputElement).blur()
      }
      className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400 disabled:text-gray-400"
    />
  );
}

const CHIP_STYLES = {
  hard: "bg-teal-700 text-white",
  soft: "border border-dashed border-teal-700 text-teal-800",
  unverifiable: "border border-dotted border-gray-400 text-gray-500",
};

function Chip({
  label,
  kind,
  onRemove,
}: {
  label: string;
  kind: keyof typeof CHIP_STYLES;
  onRemove: () => void;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs ${CHIP_STYLES[kind]}`}
    >
      {label}
      <button
        onClick={onRemove}
        aria-label={`删除：${label}`}
        className="opacity-60 hover:opacity-100"
      >
        ×
      </button>
    </span>
  );
}
