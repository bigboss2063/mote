// 一次性清理：把旧版洞察正文里的 `[[memo|[n]]]` 还原成纯文本 `[n]`。
// 现在引用编号靠 frontmatter 的 sources 顺序解析，正文不再需要链接语法。
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const positional = args.filter((arg) => !arg.startsWith("--"));
const vault = path.resolve(positional[0] ?? process.cwd());

async function folder() {
  try {
    const raw = await fs.readFile(
      path.join(vault, ".obsidian/plugins/mote/data.json"),
      "utf8"
    );
    return JSON.parse(raw).folder || "Mote";
  } catch {
    return "Mote";
  }
}

const LINKED = /\[\[[^\]\n]*\|\[(\d+)\]\]\]/g;

const dir = path.join(vault, await folder(), "_insights");
let changed = 0;
let checked = 0;
try {
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith(".md")) continue;
    checked++;
    const file = path.join(dir, name);
    const raw = await fs.readFile(file, "utf8");
    const next = raw.replace(LINKED, "[$1]");
    if (next === raw) continue;
    changed++;
    console.log(`  ${name}`);
    if (apply) await fs.writeFile(file, next, "utf8");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

console.log(
  `\nvault: ${vault}\n洞察: ${checked}，需要还原: ${changed}${apply ? "（已写入）" : "（dry run，加 --apply 执行）"}`
);
