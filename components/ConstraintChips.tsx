"use client";

import type { Constraints } from "@/lib/types";

// 约束标签：让用户看到 TT 是怎么理解自己的，不对就删掉（US1、US2）。

type Props = {
  constraints: Constraints;
  onRemoveHard: (index: number) => void;
  onRemoveSoft: (index: number) => void;
};

export default function ConstraintChips({ constraints, onRemoveHard, onRemoveSoft }: Props) {
  const { hard, soft, conflicts, origin, days, time_window, slots } = constraints;
  const SLOT_NAMES = { companions: "同行", transport: "交通", budget: "预算", pace: "节奏" } as const;
  const slotEntries = (Object.keys(SLOT_NAMES) as (keyof typeof SLOT_NAMES)[])
    .map((k) => ({ name: SLOT_NAMES[k], ...slots[k] }))
    .filter((s) => s.value);
  const facts = [
    origin && `出发地：${origin}`,
    days && `${days} 天`,
    time_window && `时间：${time_window}`,
    ...slotEntries.filter((s) => s.source === "user").map((s) => `${s.name}：${s.value}`),
  ].filter(Boolean) as string[];
  const assumptions = slotEntries.filter((s) => s.source === "assumed");

  return (
    <div className="space-y-2 rounded-xl border border-gray-200 bg-white p-3">
      <div className="text-xs font-medium text-gray-500">我拆出来的条件</div>
      <div className="flex flex-wrap gap-1.5">
        {hard.map((h, i) => (
          <Chip key={`h${i}`} kind="hard" label={h.label} onRemove={() => onRemoveHard(i)} />
        ))}
        {soft.map((s, i) => (
          <Chip
            key={`s${i}`}
            kind={s.type === "preference" ? "unverifiable" : "soft"}
            label={s.label}
            onRemove={() => onRemoveSoft(i)}
          />
        ))}
        {facts.map((f) => (
          <span key={f} className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">
            {f}
          </span>
        ))}
        {assumptions.map((s) => (
          <span
            key={s.name}
            title="这是 TT 的假设，不对的话直接在对话里告诉它"
            className="rounded-full bg-sky-50 px-2.5 py-1 text-xs text-sky-700"
          >
            假设 · {s.name}：{s.value}
          </span>
        ))}
      </div>
      {conflicts.length > 0 && (
        <div className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
          ⚠️ {conflicts.join("；")}
        </div>
      )}
      <div className="flex gap-3 pt-1 text-[11px] text-gray-400">
        <span>■ 必须满足</span>
        <span>▢ 满足更好</span>
        <span>◌ 暂无数据验证</span>
      </div>
    </div>
  );
}

const STYLES = {
  hard: "border border-teal-700 bg-teal-700 text-white",
  soft: "border border-dashed border-teal-700 text-teal-800",
  unverifiable: "border border-dotted border-gray-400 text-gray-500",
};

function Chip({
  kind,
  label,
  onRemove,
}: {
  kind: keyof typeof STYLES;
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ${STYLES[kind]}`}>
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`删除条件：${label}`}
        className="opacity-60 hover:opacity-100"
      >
        ×
      </button>
    </span>
  );
}
