import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import { decorateCitations, type CitationRef } from "./citation-ui";

/** 一条洞察的"文档视图"：结果页和历史详情共用同一套结构与样式，
 *  差别只在动作按钮和是否显示返回按钮。 */

export interface InsightDocMeta {
  /** 视角名称，渲染成一枚强调色小胶囊。 */
  kind?: string;
  /** 其余元信息，按顺序排成一行浅色文字。 */
  items?: string[];
}

export interface InsightDocAction {
  label: string;
  /** 纯图标按钮：Lucide 图标名。文字只留在 title/aria-label。 */
  icon: string;
  /** 删除这类破坏性动作。 */
  tone?: "danger";
  onClick: (button: HTMLButtonElement) => void;
}

export interface InsightDocHeadOptions {
  title: string;
  meta?: InsightDocMeta;
}

export interface InsightDocHead {
  el: HTMLElement;
  titleEl: HTMLElement;
  metaEl: HTMLElement;
}

/** 取 Markdown 开头的标题行，用于流式阶段实时把标题顶到头部。
 *  要求标题行已经写完（后面有换行），避免标题一个字一个字地跳。 */
export function leadingHeading(markdown: string): string | null {
  const match = markdown.match(/^\s{0,3}#{1,6}\s+([^\n]+)\r?\n/);
  if (!match) return null;
  const text = match[1]
    .replace(/[*_`~]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\d+\]/g, "")
    .trim();
  return text || null;
}

/** Model output is untrusted Markdown: strip embeds and active content before
 *  handing it to Obsidian's renderer. */
export function sanitizeInsightMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[\[[^\]\n]+\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\]\(\s*(?:javascript|data):[^)]*\)/gi, "]")
    .replace(/\s(href|src)\s*=\s*(["'])\s*(?:javascript|data):[\s\S]*?\2/gi, "")
    .replace(
      /<\s*(script|iframe|object|embed|img|video|audio|source|link|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
      ""
    )
    .replace(
      /<\s*(script|iframe|object|embed|img|video|audio|source|link|style)\b[^>]*\/?\s*>/gi,
      ""
    );
}

export function renderDocMeta(el: HTMLElement, meta?: InsightDocMeta): void {
  el.empty();
  if (meta?.kind) {
    el.createSpan({ cls: "memoria-insight-doc-kind", text: meta.kind });
  }
  for (const item of meta?.items ?? []) {
    el.createSpan({ text: item });
  }
}

/** 纯图标动作按钮组：文字只保留在 title/aria-label。 */
export function renderDocActions(
  el: HTMLElement,
  actions: InsightDocAction[]
): void {
  el.empty();
  for (const action of actions) {
    const cls = ["memoria-insight-doc-action"];
    if (action.tone === "danger") cls.push("is-danger");
    const button = el.createEl("button", {
      cls: cls.join(" "),
      attr: {
        type: "button",
        title: action.label,
        "aria-label": action.label,
      },
    });
    setIcon(button, action.icon);
    button.addEventListener("click", () => action.onClick(button));
  }
}

/** 正文与操作区的收口：分割线 + 右对齐的图标按钮组。 */
export function renderDocFoot(
  parent: HTMLElement,
  actions: InsightDocAction[]
): HTMLElement {
  parent.createDiv({ cls: "memoria-insight-doc-divider" });
  const el = parent.createDiv({ cls: "memoria-insight-doc-foot" });
  renderDocActions(el, actions);
  return el;
}

export function renderDocHead(
  parent: HTMLElement,
  options: InsightDocHeadOptions
): InsightDocHead {
  const el = parent.createDiv({ cls: "memoria-insight-doc-head" });

  const titleWrap = el.createDiv({ cls: "memoria-insight-doc-title-wrap" });
  const titleEl = titleWrap.createDiv({ cls: "memoria-insight-doc-title" });
  titleEl.setText(options.title);
  const metaEl = titleWrap.createDiv({ cls: "memoria-insight-doc-meta" });
  renderDocMeta(metaEl, options.meta);

  return { el, titleEl, metaEl };
}

export interface InsightDocBodyOptions {
  app: App;
  component: Component;
  parent: HTMLElement;
  markdown: string;
  /** 渲染上下文，决定 `[[链接]]` 相对于哪篇笔记解析。 */
  sourcePath: string;
  /** 正文里 `[n]` 对应的来源 memo；有它才会把 [n] 换成引用按钮。 */
  citations?: CitationRef[];
  /** 点引用时回到 Mote 界面；缺省打开 memo 的 md 文件。 */
  onOpenMemo?: (file: string) => void;
}

/** 渲染正文；渲染失败时退化为纯文本。 */
export async function renderDocBody(
  options: InsightDocBodyOptions
): Promise<HTMLElement> {
  const body = options.parent.createDiv({
    cls: "memoria-insight-result memoria-insight-doc-body",
  });
  const markdown = sanitizeInsightMarkdown(options.markdown);
  try {
    await MarkdownRenderer.render(
      options.app,
      markdown,
      body,
      options.sourcePath,
      options.component
    );
  } catch {
    body.setText(markdown);
  }
  if (body.isConnected) {
    decorateCitations(
      body,
      options.app,
      options.citations ?? [],
      options.onOpenMemo
    );
  }
  return body;
}
