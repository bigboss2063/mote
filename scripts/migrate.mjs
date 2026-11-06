#!/usr/bin/env node
// ================= 一次性迁移：旧「按年一个大文件」→「一条 memo 一个文件」 =================
// 默认只打印计划；加 --apply 才真正写盘。旧文件不删除，统一移到 <folder>/_archive/。
//
//   node scripts/migrate.mjs --vault "C:\path\to\vault" [--folder Mote] [--apply]

import fs from "node:fs/promises";
import path from "node:path";

// ---------- 旧格式解析（与 2.6.0 的 parser.parseFile 等价） ----------

const DATE_RE = /^##\s+(\d{4}-\d{2}-\d{2})(?:\s+.+)?$/;
const MEMO_RE = /^-\s+(\d{2}:\d{2})\s?(.*)$/;
const YEAR_RE = /^#\s+\d{4}\s*$/;

function parseYearFile(raw) {
  const lines = raw.split(/\r?\n/);
  const memos = [];
  let date = "";
  let i = 0;
  while (i < lines.length) {
    const header = lines[i].match(DATE_RE);
    if (header) { date = header[1]; i++; continue; }
    const start = lines[i].match(MEMO_RE);
    if (!start || !date) { i++; continue; }
    const body = [start[2] ?? ""];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (MEMO_RE.test(next) || DATE_RE.test(next) || YEAR_RE.test(next)) break;
      if (next.startsWith("  ")) { body.push(next.slice(2)); i++; continue; }
      if (next.trim() === "") {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j >= lines.length) break;
        const peek = lines[j];
        if (MEMO_RE.test(peek) || DATE_RE.test(peek) || YEAR_RE.test(peek)) break;
        if (peek.startsWith("  ")) {
          for (let k = i; k < j; k++) body.push("");
          i = j;
          continue;
        }
      }
      break;
    }
    while (body.length && body[0].trim() === "") body.shift();
    while (body.length && body[body.length - 1].trim() === "") body.pop();
    memos.push({date, time: start[1], content: body.join("\n")});
  }
  return memos;
}

// ---------- 新旧名字 ----------

const pad = (n) => String(n).padStart(2, "0");

function memoName({date, time}, index) {
  const [h, m] = time.split(":");
  return `${date} ${h}.${m}${index > 0 ? `.${pad(index)}` : ""}`;
}

const INVALID_TITLE = /[\\/:*?"<>|#^[\]]/g;
function safeTitle(title) {
  const cleaned = (title || "")
    .replace(INVALID_TITLE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "")
    .slice(0, 60)
    .trim();
  return cleaned || "洞察";
}

const localIso = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
};

// ---------- 旧洞察解析（与 2.6.0 的 serializeInsightHistory 等价） ----------

function parseInsights(raw) {
  const re = /<!--\s*mote-insight:([\s\S]*?)-->\r?\n([\s\S]*?)\r?\n<!--\s*\/mote-insight\s*-->/g;
  const records = [];
  for (const match of raw.matchAll(re)) {
    try {
      records.push({...JSON.parse(match[1]), markdown: match[2].trim()});
    } catch {
      // 坏掉的一段不影响后面的记录
    }
  }
  return records;
}

/**
 * 正文里的 [n] 保持纯文本（渲染时按 sources 顺序解析），
 * 这里只把来源按 id 排成 frontmatter 的 sources 列表。
 */
function sourceLinks(record, findMemo) {
  const links = [];
  for (const source of record.sources || []) {
    const name = findMemo(source);
    if (!name) throw new Error(`洞察「${record.title}」的来源 ${source.id} 找不到对应 memo`);
    links[source.id - 1] = name;
  }
  for (let i = 0; i < links.length; i++) {
    if (!links[i]) throw new Error(`洞察「${record.title}」的来源编号不连续`);
  }
  return links;
}

// ---------- 主流程 ----------

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const apply = args.includes("--apply");
const vault = path.resolve(option("vault", process.cwd()));

async function readSettingsFolder() {
  const explicit = option("folder", null);
  if (explicit) return explicit;
  try {
    const raw = await fs.readFile(path.join(vault, ".obsidian/plugins/mote/data.json"), "utf8");
    return JSON.parse(raw).folder || "Mote";
  } catch {
    return "Mote";
  }
}

async function main() {
  const folder = await readSettingsFolder();
  const root = path.join(vault, folder);
  const archive = path.join(root, "_archive");

  const entries = await fs.readdir(root, {withFileTypes: true}).catch(() => []);
  const yearFiles = entries
    .filter((e) => e.isFile() && /^\d{4}\.md$/.test(e.name))
    .map((e) => e.name)
    .sort();

  // 已存在的新格式文件，避免覆盖、解决同分钟冲突
  const existing = new Set();
  for (const dir of entries.filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name))) {
    for (const name of await fs.readdir(path.join(root, dir.name))) {
      if (name.endsWith(".md")) existing.add(`${dir.name}/${name}`);
    }
  }

  // 1. 旧 memo → 新文件
  const memos = [];
  const moves = [];
  const byMinute = new Map();
  for (const yearFile of yearFiles) {
    const parsed = parseYearFile(await fs.readFile(path.join(root, yearFile), "utf8"));
    for (const memo of parsed) {
      const key = `${memo.date} ${memo.time}`;
      let index = byMinute.get(key) ?? 0;
      const year = memo.date.slice(0, 4);
      while (existing.has(`${year}/${memoName(memo, index)}.md`)) index++;
      byMinute.set(key, index + 1);
      const name = memoName(memo, index);
      existing.add(`${year}/${name}.md`);
      memos.push({...memo, name, rel: `${year}/${name}.md`, yearFile});
      const bucket = byMinute.get(`${key}/list`) ?? [];
      bucket.push({name, content: memo.content});
      byMinute.set(`${key}/list`, bucket);
    }
    moves.push({from: path.join(root, yearFile), to: path.join(archive, yearFile)});
  }

  const findMemo = (source) => {
    const bucket = byMinute.get(`${source.date} ${source.time}/list`) ?? [];
    if (!bucket.length) return null;
    const excerpt = (source.excerpt || "").slice(0, 40);
    return (
      bucket.find((m) => m.content.startsWith(excerpt) || excerpt.startsWith(m.content.slice(0, 40))) ??
      bucket[0]
    ).name;
  };

  // 2. 旧洞察 → 新文件
  const insights = [];
  const insightsPath = path.join(root, "_insights.md");
  let oldInsights = "";
  try {
    oldInsights = await fs.readFile(insightsPath, "utf8");
  } catch {
    oldInsights = "";
  }
  for (const record of parseInsights(oldInsights)) {
    const createdAt = typeof record.createdAt === "number" && record.createdAt > 0
      ? record.createdAt : Date.now();
    const title = record.title || "AI 洞察";
    const resolved = {...record, title, createdAt};
    insights.push({record: resolved, links: sourceLinks(resolved, findMemo), file: `${stamp(createdAt)} ${safeTitle(title)}.md`});
  }

  console.log(`vault:  ${vault}`);
  console.log(`folder: ${folder}`);
  console.log(`旧年文件: ${yearFiles.length}，memo: ${memos.length}，旧洞察: ${insights.length}`);
  for (const memo of memos) console.log(`  memo     ${memo.yearFile} -> ${folder}/${memo.rel}`);
  for (const insight of insights) console.log(`  insight  _insights.md -> ${folder}/_insights/${insight.file}`);

  if (!apply) {
    console.log("\n(dry run，未写盘；加 --apply 执行)");
    return;
  }

  const writeNew = async (abs, content) => {
    await fs.mkdir(path.dirname(abs), {recursive: true});
    await fs.writeFile(abs, content, {flag: "wx"});
  };

  for (const memo of memos) {
    await writeNew(path.join(root, memo.rel), `${memo.content}\n`);
  }

  if (insights.length) {
    for (const {record, links, file} of insights) {
      const body = record.markdown.replace(/^\s{0,3}#{1,6}\s+[^\n]*\n+/, "");
      const lines = [
        "---",
        "mote: insight",
        `created: ${localIso(record.createdAt)}`,
        `title: ${JSON.stringify(record.title)}`,
      ];
      if (record.perspectiveLabel) lines.push(`kind: ${JSON.stringify(record.perspectiveLabel)}`);
      if (record.scopeDescription) lines.push(`scope: ${JSON.stringify(record.scopeDescription)}`);
      if (record.noteCount > 0) lines.push(`notes: ${record.noteCount}`);
      if (links.length) {
        lines.push("sources:");
        for (const link of links) lines.push(`  - "[[${link}]]"`);
      }
      lines.push("---", "", `# ${record.title}`, "");
      if (body) lines.push(body, "");
      await writeNew(path.join(root, "_insights", file), lines.join("\n"));
    }
  }

  // 3. 旧文件归档（保留可回滚）
  await fs.mkdir(archive, {recursive: true});
  const moveToArchive = async (from, base) => {
    let dest = path.join(archive, base);
    try {
      await fs.access(dest);
      dest = dest.replace(/\.md$/, ` ${Date.now()}.md`);
    } catch {
      // 目标不存在
    }
    await fs.rename(from, dest);
  };
  for (const move of moves) await moveToArchive(move.from, path.basename(move.from));
  if (insights.length) await moveToArchive(insightsPath, "_insights.md").catch(() => {});

  console.log("\n完成。旧文件已移到 _archive/。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
