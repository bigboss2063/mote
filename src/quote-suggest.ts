// ================= 引用联想下拉框 =================
// 输入框里打 `@` 时弹出：搜索库里的 memo / 洞察，选中后插入紧凑双链
// `[[完整路径|↗]]`。渲染层（ai/citation-ui）会把它变成可 hover 预览的箭头，
// 所以这里只管"找东西 + 插链接"，不碰存储格式。

import { setIcon } from "obsidian";
import { replaceTextareaRange } from "./textarea-utils";
import { caretAnchor, placePopup } from "./caret-position";

export interface QuoteCandidate {
  /** 完整 vault 路径 */
  file: string;
  /** 候选标题：memo 的日期时间 / 洞察标题 */
  title: string;
  /** 正文全文：搜索用全文，显示时再截成一行（matchSnippet） */
  snippet: string;
  kind: "memo" | "insight";
  /** 排序用：memo 时间戳 / 洞察创建时间 */
  time: number;
}

export interface QuoteTrigger {
  /** 触发点：`@` 的位置 */
  start: number;
  /** `@` 之后、光标之前的输入 */
  query: string;
}

/** 光标是否正处在待补全的 `@查询` 里；邮箱（user@host）之类不算。 */
export function findQuoteTrigger(text: string, pos: number): QuoteTrigger | null {
  const open = text.lastIndexOf("@", pos);
  if (open < 0) return null;
  // 未闭合的 `[[` 交给文章联想，避免和 memo 下拉叠在一起
  if (insideUnclosedWiki(text, open)) return null;
  const query = text.slice(open + 1, pos);
  // 换行表示这段已经写完了，不再补全
  if (query.includes("\n")) return null;
  // `@` 紧跟在英文/数字后面多半是邮箱或代码，不弹；中文、标点、空白前都算
  if (open > 0 && /[A-Za-z0-9._%+-]/.test(text[open - 1])) return null;
  return { start: open, query };
}

/** `@` 是否落在同一行、尚未写出 `]` 的 `[[` 里面。 */
function insideUnclosedWiki(text: string, index: number): boolean {
  const open = text.lastIndexOf("[[", index);
  if (open < 0 || open + 2 > index) return false;
  const between = text.slice(open + 2, index);
  return !between.includes("\n") && !between.includes("]");
}

/**
 * 空白分词，全部命中才算匹配（AND）。
 * 标题（日期时间 / 洞察标题）命中权重高于正文和路径，同分按时间倒序。
 */
export function matchQuoteCandidates(
  all: QuoteCandidate[],
  query: string,
  limit = 10
): QuoteCandidate[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return all.slice(0, limit);
  const scored: { item: QuoteCandidate; score: number }[] = [];
  for (const item of all) {
    const title = item.title.toLowerCase();
    const body = item.snippet.toLowerCase();
    const path = item.file.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (title.includes(token)) score += 4;
      else if (body.includes(token)) score += 1;
      else if (path.includes(token)) score += 1;
      else {
        score = -1;
        break;
      }
    }
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || b.item.time - a.item.time);
  return scored.slice(0, limit).map((entry) => entry.item);
}

/** 显示用摘要：截取命中位置附近，让用户一眼看到为什么匹配。 */
export function matchSnippet(text: string, query: string, limit = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const lower = flat.toLowerCase();
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let at = tokens.length ? lower.indexOf(tokens.join(" ")) : -1;
  if (at < 0) {
    // 取最长的一个词找落点，避免先命中的短词把窗口带偏
    for (const token of [...tokens].sort((a, b) => b.length - a.length)) {
      at = lower.indexOf(token);
      if (at >= 0) break;
    }
  }
  if (at < 0) return quoteSnippet(flat, limit);
  const start = Math.max(0, at - 16);
  const chunk = flat.slice(start, start + limit);
  return `${start > 0 ? "…" : ""}${chunk}${start + limit < flat.length ? "…" : ""}`;
}

/** 与工具栏"引用"按钮同一格式：`[[<路径去 .md>|↗]]`。 */
export function quoteLink(file: string): string {
  return `[[${file.replace(/\.md$/, "")}|↗]]`;
}

/** 候选摘要：压成一行，最多 limit 字符。 */
export function quoteSnippet(text: string, limit = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export class QuoteSuggest {
  private dropdown: HTMLElement | null = null;
  private items: QuoteCandidate[] = [];
  private active = 0;
  /** 触发位置（`@` 的索引） */
  private rangeStart = 0;
  /** 当前查询词，渲染摘要时用来定位命中位置 */
  private query = "";
  private cached: QuoteCandidate[] | null = null;
  private cacheTime = 0;
  /** 异步取候选时，只让最后一次触发生效 */
  private token = 0;
  private static CACHE_TTL_MS = 15_000;

  constructor(
    private textarea: HTMLTextAreaElement,
    /** 候选来源由 view 提供（memo 来自 store，洞察来自文件） */
    private getCandidates: () => Promise<QuoteCandidate[]>
  ) {
    this.textarea.addEventListener("input", this.handleInput);
    // 中文输入法组词期间 value 里是拼音，搜索会一顿闪；组完再查
    this.textarea.addEventListener("compositionend", this.handleCompositionEnd);
    this.textarea.addEventListener("keydown", this.handleKeydown, true);
    this.textarea.addEventListener("blur", this.handleBlur);
    this.textarea.addEventListener("scroll", () => this.close());
  }

  destroy(): void {
    this.textarea.removeEventListener("input", this.handleInput);
    this.textarea.removeEventListener(
      "compositionend",
      this.handleCompositionEnd
    );
    this.textarea.removeEventListener("keydown", this.handleKeydown, true);
    this.textarea.removeEventListener("blur", this.handleBlur);
    this.close();
  }

  /** 发送快捷键判断要先看它：下拉开着时 Enter 是"选候选"，不是"发送"。 */
  isOpen(): boolean {
    return this.dropdown !== null;
  }

  // -------- 事件 --------

  private handleInput = (event: Event): void => {
    if ((event as InputEvent).isComposing) return;
    void this.update();
  };

  private handleCompositionEnd = (): void => {
    void this.update();
  };

  private handleBlur = (): void => {
    // 延迟，给 mousedown 一个机会触发选择
    window.setTimeout(() => this.close(), 150);
  };

  private handleKeydown = (e: KeyboardEvent): void => {
    if (!this.dropdown) return;
    // IME 组合态下的 Enter/Tab 是"确认候选词"
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
      // Ctrl/Cmd+Enter 永远是发送，让它通过
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      // stopImmediatePropagation：同一 textarea 上后注册的 keydown（发送 / 退出编辑）不参与
      e.stopImmediatePropagation();
      this.applySelected();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.close();
    }
  };

  // -------- 数据 --------

  private async update(): Promise<void> {
    const trigger = findQuoteTrigger(
      this.textarea.value,
      this.textarea.selectionStart ?? 0
    );
    if (!trigger) {
      this.close();
      return;
    }
    this.rangeStart = trigger.start;
    const token = ++this.token;
    const all = await this.candidates();
    if (token !== this.token || !this.textarea.isConnected) return;
    // 等待期间用户可能已经闭合链接或换了位置
    const now = findQuoteTrigger(
      this.textarea.value,
      this.textarea.selectionStart ?? 0
    );
    if (!now || now.start !== trigger.start) return;

    this.items = matchQuoteCandidates(all, now.query);
    if (this.items.length === 0) {
      this.close();
      return;
    }
    this.query = now.query;
    this.active = 0;
    this.render();
  }

  private async candidates(): Promise<QuoteCandidate[]> {
    if (this.cached && Date.now() - this.cacheTime < QuoteSuggest.CACHE_TTL_MS) {
      return this.cached;
    }
    const result = await this.getCandidates();
    this.cached = result;
    this.cacheTime = Date.now();
    return result;
  }

  // -------- UI --------

  private render(): void {
    if (!this.dropdown) {
      // 复用标签联想的浮层样式（定位 / 底色 / 阴影一致）
      this.dropdown = activeDocument.body.createDiv({
        cls: "memoria-tag-suggest memoria-quote-suggest",
      });
      // 阻止点击下拉框时 textarea 的 blur 抢先关闭
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
      setIcon(icon, item.kind === "insight" ? "sparkles" : "feather");
      const text = row.createDiv({ cls: "memoria-quote-text" });
      text.createDiv({ cls: "memoria-quote-title", text: item.title });
      if (item.snippet) {
        text.createDiv({
          cls: "memoria-quote-snippet",
          text: matchSnippet(item.snippet, this.query),
        });
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

  /** 贴在光标行下方；下面放不下（FAB 输入框贴底）就翻到上方。 */
  private position(): void {
    if (!this.dropdown) return;
    const rect = this.textarea.getBoundingClientRect();
    this.dropdown.style.minWidth = `${Math.min(rect.width, 340)}px`;
    const placement = placePopup(
      caretAnchor(this.textarea),
      { width: this.dropdown.offsetWidth, height: this.dropdown.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight }
    );
    this.dropdown.style.top = `${placement.top}px`;
    this.dropdown.style.left = `${placement.left}px`;
  }

  private applySelected(): void {
    if (!this.dropdown || !this.items.length) return;
    const chosen = this.items[this.active];
    const pos = this.textarea.selectionStart ?? 0;
    // 后面紧跟文字时补一个空格，避免链接黏住下一段
    const tail = this.textarea.value.slice(pos);
    const insert = quoteLink(chosen.file) + (/^[\s),，。]/.test(tail) || !tail ? "" : " ");
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
    this.token++;
  }
}
