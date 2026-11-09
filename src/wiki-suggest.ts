// ================= 文章联想下拉框 =================
// 输入框里打 `[[` 时弹出：搜索库里的 Markdown 笔记（不含 Mote 自己的 memo
// 目录，那些走 `@`），选中后插入普通双链 `[[笔记名]]`。
// 浮层直接复用标签 / 引用联想的 class，不另做一套样式。

import { App, setIcon, TFile } from "obsidian";
import { replaceTextareaRange } from "./textarea-utils";
import { caretAnchor, placePopup } from "./caret-position";
import { visibleViewport } from "./mobile-navbar";

export interface WikiCandidate {
  /** 完整 vault 路径 */
  file: string;
  /** 文件名（不含扩展名） */
  title: string;
  /** 所在文件夹；库根目录的笔记为空字符串 */
  folder: string;
  /** frontmatter 里的 aliases / alias */
  aliases: string[];
  /** 排序用：文件修改时间 */
  mtime: number;
}

export interface WikiTrigger {
  /** `[[` 的起始索引 */
  start: number;
  /** `[[` 与光标之间、用来搜索的文字 */
  query: string;
}

/** 这条路径是不是落在 memo 目录里（`@` 联想已经覆盖）。 */
export function isInMemoFolder(path: string, memoFolder: string): boolean {
  const folder = memoFolder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!folder) return false;
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * 光标是否正在写一段还没闭合的 `[[...`。
 * 已经写出 `]]`、换行，或开始写别名 / 标题锚点（`|` `#` `^`）时不弹。
 * `![[` 的 `!` 留在触发点前面，选中后自然变成嵌入。
 */
export function findWikiTrigger(text: string, pos: number): WikiTrigger | null {
  const open = text.lastIndexOf("[[", pos);
  if (open < 0 || pos < open + 2) return null;
  const query = text.slice(open + 2, pos);
  if (query.includes("\n") || /[\]|#^]/.test(query)) return null;
  const rest = text.slice(pos);
  const lineBreak = rest.indexOf("\n");
  const line = lineBreak >= 0 ? rest.slice(0, lineBreak) : rest;
  if (line.includes("]")) return null;
  return { start: open, query };
}

/**
 * 空白分词，全部命中才算匹配（AND）。
 * 标题前缀 > 标题包含 > 别名前缀 > 别名包含 > 路径包含；同分取最近修改的。
 * 空查询返回最近修改的若干篇。
 */
export function matchWikiCandidates(
  all: WikiCandidate[],
  query: string,
  limit = 8
): WikiCandidate[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return [...all]
      .sort((a, b) => b.mtime - a.mtime || a.title.localeCompare(b.title))
      .slice(0, limit);
  }
  const whole = query.trim().toLowerCase();
  const scored: { item: WikiCandidate; score: number }[] = [];
  for (const item of all) {
    const title = item.title.toLowerCase();
    const aliases = item.aliases.map((alias) => alias.toLowerCase());
    const path = `${item.folder}/${item.title}`.toLowerCase();
    let score = title === whole ? 20 : 0;
    let matched = true;
    for (const token of tokens) {
      if (title.startsWith(token)) score += 8;
      else if (title.includes(token)) score += 5;
      else if (aliases.some((alias) => alias.startsWith(token))) score += 6;
      else if (aliases.some((alias) => alias.includes(token))) score += 3;
      else if (path.includes(token)) score += 1;
      else {
        matched = false;
        break;
      }
    }
    if (matched) scored.push({ item, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.item.mtime - a.item.mtime ||
      a.item.title.localeCompare(b.item.title)
  );
  return scored.slice(0, limit).map((entry) => entry.item);
}

/** `[[笔记名]]`；fileToLinktext 有时带 `.md`，这里去掉。 */
export function wikiLink(linktext: string): string {
  const target = linktext.trim().replace(/\.md$/i, "");
  return `[[${target}]]`;
}

function readAliases(frontmatter: { [key: string]: unknown } | undefined): string[] {
  if (!frontmatter) return [];
  const raw = frontmatter.aliases ?? frontmatter.alias;
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return list
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim());
}

export class WikiSuggest {
  private dropdown: HTMLElement | null = null;
  private items: WikiCandidate[] = [];
  private active = 0;
  /** 触发位置（`[[` 的索引） */
  private rangeStart = 0;
  private cached: WikiCandidate[] | null = null;
  private cachedFolder = "";
  private cacheTime = 0;
  private refs: { unref: () => void }[] = [];
  private static CACHE_TTL_MS = 15_000;

  constructor(
    private app: App,
    private textarea: HTMLTextAreaElement,
    /** memo 目录不进文章列表；设置页改了目录后下次收集会重新读 */
    private getMemoFolder: () => string
  ) {
    this.textarea.addEventListener("input", this.handleInput);
    this.textarea.addEventListener("compositionend", this.handleCompositionEnd);
    this.textarea.addEventListener("keydown", this.handleKeydown, true);
    this.textarea.addEventListener("blur", this.handleBlur);
    this.textarea.addEventListener("scroll", this.handleScroll);
    const drop = () => {
      this.cached = null;
    };
    const changed = this.app.metadataCache.on("changed", drop);
    const created = this.app.vault.on("create", drop);
    const deleted = this.app.vault.on("delete", drop);
    const renamed = this.app.vault.on("rename", drop);
    this.refs = [
      { unref: () => this.app.metadataCache.offref(changed) },
      { unref: () => this.app.vault.offref(created) },
      { unref: () => this.app.vault.offref(deleted) },
      { unref: () => this.app.vault.offref(renamed) },
    ];
  }

  destroy(): void {
    this.textarea.removeEventListener("input", this.handleInput);
    this.textarea.removeEventListener("compositionend", this.handleCompositionEnd);
    this.textarea.removeEventListener("keydown", this.handleKeydown, true);
    this.textarea.removeEventListener("blur", this.handleBlur);
    this.textarea.removeEventListener("scroll", this.handleScroll);
    for (const ref of this.refs) ref.unref();
    this.refs = [];
    this.close();
  }

  /** 发送快捷键判断要先看它：下拉开着时 Enter 是"选候选"，不是"发送"。 */
  isOpen(): boolean {
    return this.dropdown !== null;
  }

  // -------- 事件 --------

  private handleInput = (event: Event): void => {
    if ((event as InputEvent).isComposing) return;
    this.update();
  };

  private handleCompositionEnd = (): void => {
    this.update();
  };

  private handleBlur = (): void => {
    window.setTimeout(() => this.close(), 150);
  };

  private handleScroll = (): void => {
    this.close();
  };

  private handleKeydown = (e: KeyboardEvent): void => {
    if (!this.dropdown) return;
    if (e.isComposing || (e as KeyboardEvent & { keyCode?: number }).keyCode === 229) {
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.active = (this.active + 1) % this.items.length;
      this.refreshActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.active = (this.active - 1 + this.items.length) % this.items.length;
      this.refreshActive();
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.applySelected();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.close();
    }
  };

  // -------- 数据 --------

  private update(): void {
    const trigger = findWikiTrigger(
      this.textarea.value,
      this.textarea.selectionStart ?? 0
    );
    if (!trigger) {
      this.close();
      return;
    }
    this.rangeStart = trigger.start;
    const items = matchWikiCandidates(this.candidates(), trigger.query);
    if (items.length === 0) {
      this.close();
      return;
    }
    this.items = items;
    this.active = 0;
    this.render();
  }

  private candidates(): WikiCandidate[] {
    const folder = this.getMemoFolder();
    if (
      this.cached &&
      this.cachedFolder === folder &&
      Date.now() - this.cacheTime < WikiSuggest.CACHE_TTL_MS
    ) {
      return this.cached;
    }
    const result: WikiCandidate[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (isInMemoFolder(file.path, folder)) continue;
      const slash = file.path.lastIndexOf("/");
      const meta = this.app.metadataCache.getFileCache(file);
      result.push({
        file: file.path,
        title: file.basename,
        folder: slash >= 0 ? file.path.slice(0, slash) : "",
        aliases: readAliases(meta?.frontmatter),
        mtime: file.stat.mtime,
      });
    }
    this.cached = result;
    this.cachedFolder = folder;
    this.cacheTime = Date.now();
    return result;
  }

  // -------- UI --------

  private render(): void {
    if (!this.dropdown) {
      // 和引用联想一样：标签浮层的底色 / 阴影 / 定位，候选两行（标题 + 路径）
      this.dropdown = activeDocument.body.createDiv({
        cls: "memoria-tag-suggest memoria-quote-suggest",
      });
      this.dropdown.addEventListener("mousedown", (e) => e.preventDefault());
    }
    this.dropdown.empty();
    this.items.forEach((item, i) => {
      const row = this.dropdown!.createDiv({
        cls:
          "memoria-tag-suggest-item memoria-quote-item" +
          (i === this.active ? " active" : ""),
      });
      const icon = row.createSpan({ cls: "memoria-tag-suggest-icon" });
      setIcon(icon, "file-text");
      const text = row.createDiv({ cls: "memoria-quote-text" });
      text.createDiv({ cls: "memoria-quote-title", text: item.title });
      if (item.folder) {
        text.createDiv({ cls: "memoria-quote-snippet", text: item.folder });
      }
      row.addEventListener("click", () => {
        this.active = i;
        this.applySelected();
      });
    });
    this.position();
  }

  private refreshActive(): void {
    if (!this.dropdown) return;
    const items = this.dropdown.querySelectorAll(".memoria-tag-suggest-item");
    items.forEach((el, i) => {
      el.toggleClass("active", i === this.active);
    });
    const activeEl = items[this.active] as HTMLElement | undefined;
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }

  private position(): void {
    if (!this.dropdown) return;
    const rect = this.textarea.getBoundingClientRect();
    this.dropdown.style.minWidth = `${Math.min(rect.width, 340)}px`;
    const placement = placePopup(
      caretAnchor(this.textarea),
      { width: this.dropdown.offsetWidth, height: this.dropdown.offsetHeight },
      visibleViewport(this.textarea.ownerDocument)
    );
    this.dropdown.style.top = `${placement.top}px`;
    this.dropdown.style.left = `${placement.left}px`;
  }

  private applySelected(): void {
    if (!this.dropdown || !this.items.length) return;
    const chosen = this.items[this.active];
    const file = this.app.vault.getAbstractFileByPath(chosen.file);
    if (!(file instanceof TFile)) {
      this.close();
      return;
    }
    const linktext = this.app.metadataCache.fileToLinktext(file, "", false);
    const pos = this.textarea.selectionStart ?? 0;
    const tail = this.textarea.value.slice(pos);
    const insert = wikiLink(linktext) + (/^[\s),，。]/.test(tail) || !tail ? "" : " ");
    replaceTextareaRange(this.textarea, this.rangeStart, pos, insert);
    this.textarea.focus();
    this.close();
  }

  private close(): void {
    if (this.dropdown) {
      this.dropdown.remove();
      this.dropdown = null;
    }
    this.items = [];
    this.active = 0;
  }
}
