import { App, Notice, TFile, setIcon } from "obsidian";
import { memoFileInfo, parseMemoFile } from "../parser";
import { RESERVED_TAGS } from "../types";
import { t } from "../i18n";
import type { Memo } from "../types";

/** 正文里的一条引用：`[n]` → 对应的 memo 文件路径。 */
export interface CitationRef {
  id: number;
  /** 空字符串表示来源 memo 已找不到。 */
  file: string;
}

const CITATION = /\[(\d+)\]/g;
const EXCERPT_LIMIT = 240;
const CLOSE_DELAY = 160;

interface CitationCard {
  el: HTMLElement;
  win: Window;
  closeTimer: number | null;
  detach: () => void;
}

let activeCard: CitationCard | null = null;
let openToken = 0;

/** 关掉引用浮窗；弹窗关闭时调用，避免卡片留在 body 上。 */
export function dismissCitationPreview(): void {
  openToken++;
  closeCitationCard();
}

/**
 * 把正文里的 `[n]` 换成旧版引用按钮：箭头图标 + hover 预览 + 点击回 Mote。
 * 用纯文本标记而不是 wikilink，渲染不受链接解析影响，停用插件也照样可读。
 */
export function decorateCitations(
  root: HTMLElement,
  app: App,
  citations: CitationRef[],
  onOpenMemo?: (file: string) => void
): void {
  const byId = new Map(citations.map((item) => [item.id, item.file]));
  if (byId.size === 0) return;

  const doc = root.ownerDocument;
  const win = doc.defaultView ?? window;
  const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("a, code, pre")) continue;
    if (CITATION.test(node.nodeValue ?? "")) nodes.push(node);
    CITATION.lastIndex = 0;
  }

  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    const fragment = doc.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(CITATION)) {
      const index = match.index ?? 0;
      const file = byId.get(Number(match[1]));
      if (file === undefined) continue;
      if (index > last) fragment.append(text.slice(last, index));

      const cite = doc.createElement("button");
      cite.className = "memoria-insight-cite";
      cite.setAttribute("type", "button");
      cite.setAttribute("aria-label", t("insight.openSource"));
      setIcon(cite, "arrow-up-right");
      cite.addEventListener("mouseenter", () => {
        void showCitation(cite, app, file);
      });
      cite.addEventListener("focus", () => {
        void showCitation(cite, app, file);
      });
      cite.addEventListener("mouseleave", () => {
        scheduleCloseCitation();
      });
      cite.addEventListener("blur", () => scheduleCloseCitation(0));
      cite.addEventListener("click", (event) => {
        event.preventDefault();
        dismissCitationPreview();
        if (!file) {
          new Notice(t("insight.history.sourceMissing"));
          return;
        }
        if (onOpenMemo) {
          onOpenMemo(file);
          return;
        }
        const target = app.vault.getAbstractFileByPath(file);
        if (target instanceof TFile) void app.workspace.getLeaf(false).openFile(target);
      });
      fragment.append(cite);
      last = index + match[0].length;
    }
    if (last === 0) continue;
    if (last < text.length) fragment.append(text.slice(last));
    node.parentNode?.replaceChild(fragment, node);
  }
}

async function showCitation(
  anchor: HTMLElement,
  app: App,
  file: string
): Promise<void> {
  if (!file) return;
  const target = app.vault.getAbstractFileByPath(file);
  if (!(target instanceof TFile) || !memoFileInfo(target.path)) return;
  const token = ++openToken;
  let memo: Memo | null = null;
  try {
    memo = parseMemoFile(target.path, await app.vault.cachedRead(target));
  } catch {
    return;
  }
  if (token !== openToken || !memo || !anchor.isConnected) return;
  const doc = anchor.ownerDocument;
  if (anchor !== doc.activeElement && !anchor.matches(":hover")) return;
  openCitationCard(anchor, memo);
}

function openCitationCard(anchor: HTMLElement, memo: Memo): void {
  closeCitationCard();
  const doc = anchor.ownerDocument;
  const win = doc.defaultView ?? window;

  const card = doc.createElement("div");
  card.className = "memoria-insight-cite-card";
  card.setAttribute("role", "tooltip");
  card.createDiv({
    cls: "memoria-insight-cite-time",
    text: `${memo.date} ${memo.time}`,
  });
  card.createDiv({
    cls: "memoria-insight-cite-text",
    text: excerpt(memo.content),
  });
  const tags = memo.tags
    .filter((tag) => !RESERVED_TAGS.has(tag))
    .slice(0, 4);
  if (tags.length) {
    const tagWrap = card.createDiv({ cls: "memoria-insight-cite-tags" });
    for (const tag of tags) {
      tagWrap.createSpan({ cls: "memoria-insight-cite-tag", text: `#${tag}` });
    }
  }
  doc.body.appendChild(card);

  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const left = Math.max(
    margin,
    Math.min(rect.left + rect.width / 2 - width / 2, win.innerWidth - width - margin)
  );
  const above = rect.top - height - margin;
  const below = rect.bottom + margin;
  const top =
    above >= margin
      ? above
      : Math.max(margin, Math.min(below, win.innerHeight - height - margin));
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;

  card.addEventListener("mouseenter", cancelCloseCitation);
  card.addEventListener("mouseleave", () => scheduleCloseCitation());

  const onScroll = () => closeCitationCard();
  const onResize = () => closeCitationCard();
  const onPointerDown = () => closeCitationCard();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeCitationCard();
  };
  win.addEventListener("scroll", onScroll, true);
  win.addEventListener("resize", onResize);
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);

  activeCard = {
    el: card,
    win,
    closeTimer: null,
    detach: () => {
      win.removeEventListener("scroll", onScroll, true);
      win.removeEventListener("resize", onResize);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
    },
  };
}

function excerpt(content: string): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return t("list.noText");
  return text.length > EXCERPT_LIMIT
    ? `${text.slice(0, EXCERPT_LIMIT)}…`
    : text;
}

function cancelCloseCitation(): void {
  if (!activeCard || activeCard.closeTimer === null) return;
  activeCard.win.clearTimeout(activeCard.closeTimer);
  activeCard.closeTimer = null;
}

function scheduleCloseCitation(delay = CLOSE_DELAY): void {
  const card = activeCard;
  if (!card) return;
  cancelCloseCitation();
  card.closeTimer = card.win.setTimeout(() => {
    if (activeCard === card) closeCitationCard();
  }, delay);
}

function closeCitationCard(): void {
  const card = activeCard;
  if (!card) return;
  if (card.closeTimer !== null) card.win.clearTimeout(card.closeTimer);
  card.detach();
  card.el.remove();
  activeCard = null;
}
