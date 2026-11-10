// 朋友试用的数据辅助脚本（只在本地运行，数据都在 data/ 里，不会提交进代码仓库）。
//
// 为什么需要：首页对话会把念头存进灵感池，开始规划时 TT 会调用这些记忆。
// 不处理的话，第二位朋友会听到 TT 说"你之前说过……"——其实是上一位朋友（或者你自己）说的，测试结果就被污染了。
//
// 用法（先停掉开发服务器，或者确保没人在用）：
//   node scripts/trial.mjs backup      试用开始前：完整备份数据库到 data/backup-<时间>.db
//   node scripts/trial.mjs reset       每位朋友开始前：先把上一位的首页对话和灵感卡片存到 data/trial-session-<时间>.json，
//                                      再清空灵感池和首页对话（规划保留，方便事后分析）
//   node scripts/trial.mjs export      全部结束后：把备份之后新建的规划导出到 data/trial-results-<时间>.json
//   node scripts/trial.mjs restore     导出之后：用最近一次备份恢复成试用前的数据
//   node scripts/trial.mjs status      看看现在有多少灵感卡片、对话和规划

import { copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = path.join(process.cwd(), "data");
const dbPath = path.join(dir, "triptrace.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backups = () =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^backup-.*\.db$/.test(f))
        .sort()
    : [];

const command = process.argv[2];

if (command === "backup") {
  const target = path.join(dir, `backup-${stamp}.db`);
  copyFileSync(dbPath, target);
  console.log(`已备份到 ${target}`);
} else if (command === "reset") {
  if (!backups().length) {
    console.error("还没有备份。先运行：node scripts/trial.mjs backup");
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath);
  // 上一位朋友在首页说的原话（T1）是最有价值的材料，清空之前先存下来
  const saved = {
    savedAt: stamp,
    conversations: db.prepare("SELECT * FROM conversations").all(),
    cards: db.prepare("SELECT * FROM inspiration_cards").all(),
  };
  if (saved.conversations.length || saved.cards.length) {
    const target = path.join(dir, `trial-session-${stamp}.json`);
    writeFileSync(target, JSON.stringify(saved, null, 2));
    console.log(`已把上一场的 ${saved.conversations.length} 段对话、${saved.cards.length} 张卡片存到 ${target}`);
  }
  const cards = db.prepare("DELETE FROM inspiration_cards").run().changes;
  const conversations = db.prepare("DELETE FROM conversations").run().changes;
  console.log(`已清空：灵感卡片 ${cards} 张、首页对话 ${conversations} 段。规划保留。`);
} else if (command === "export") {
  const last = backups().at(-1);
  if (!last) {
    console.error("找不到备份，不知道哪些规划是试用时新建的。");
    process.exit(1);
  }
  const before = new DatabaseSync(path.join(dir, last));
  const known = new Set(before.prepare("SELECT id FROM plans").all().map((r) => r.id));
  const db = new DatabaseSync(dbPath);
  const plans = db
    .prepare("SELECT id, title, state, created_at, updated_at FROM plans ORDER BY id")
    .all()
    .filter((p) => !known.has(p.id))
    .map((p) => ({ ...p, state: JSON.parse(p.state) }));
  const conversations = db.prepare("SELECT * FROM conversations").all();
  const target = path.join(dir, `trial-results-${stamp}.json`);
  writeFileSync(target, JSON.stringify({ exportedAt: stamp, plans, conversations }, null, 2));
  console.log(`已导出 ${plans.length} 个试用时新建的规划、${conversations.length} 段首页对话到 ${target}`);
} else if (command === "restore") {
  const last = backups().at(-1);
  if (!last) {
    console.error("找不到备份。");
    process.exit(1);
  }
  copyFileSync(path.join(dir, last), dbPath);
  console.log(`已用 ${last} 恢复。记得先运行过 export，否则试用数据就没了。`);
} else if (command === "status") {
  const db = new DatabaseSync(dbPath);
  const count = (table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  console.log(`灵感卡片 ${count("inspiration_cards")} 张，首页对话 ${count("conversations")} 段，规划 ${count("plans")} 个`);
  console.log(`备份：${backups().join("、") || "无"}`);
} else {
  console.log("用法：node scripts/trial.mjs backup | reset | export | restore | status");
}
