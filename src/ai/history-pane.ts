import { App, Component, Notice, TFile, setIcon } from "obsidian";
import type { MemoriaSettings } from "../types";
import type { InsightRecord } from "./types";
import { getCurrentLocale, t } from "../i18n";
import {
  deleteInsightRecord,
  loadInsightRecords,
  stripLeadingTitle,
} from "./insight-file";
import { renderDocBody, renderDocFoot, renderDocHead } from "./document";
import { dismissCitationPreview, type CitationRef } from "./citation-ui";
import { memoFileInfo, memoLinkName } from "../parser";

/** frontmatter 的 sources 顺序即 `[n]` 的编号；找不到文件时留空，点击会提示。 */
function resolveCitations(app: App, names: string[]): CitationRef[] {
  const files = app.vault.getMarkdownFiles();
  return names.map((name, index) => {
    const direct = app.metadataCache.getFirstLinkpathDest(name, "");
    const file =
      direct instanceof TFile
        ? direct
        : files.find(
            (candidate) =>
              memoFileInfo(candidate.path) && memoLinkName(candidate.path) === name
          );
    return { id: index + 1, file: file?.path ?? "" };
  });
}

export interface InsightHistoryPaneOptions {
  settings: MemoriaSettings;
  /** 点引用时回到 Mote 界面。 */
  openMemo?: (file: string) => void;
  initialFile?: string;
  quoteSource?: (file: string) => void;
}

function formatCreatedAt(record: InsightRecord): string {
  if (!record.createdAt) return "";
  try {
    return new Date(record.createdAt).toLocaleString(getCurrentLocale(), {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "";
  }
}

export class InsightHistoryPane {
  private component = new Component();
  private records: InsightRecord[] = [];
  private selectedFile: string | null = null;
  /** 窄屏一次只显示列表或正文。没有指定某篇时先给列表。 */
  private showingList: boolean;
  private loading = true;
  private confirmDeleteFile: string | null = null;
  private confirmTimer: number | null = null;
  private compactQuery: MediaQueryList | null = null;
  private hostObserver: ResizeObserver | null = null;
  private renderSeq = 0;

  constructor(
    private app: App,
    private host: HTMLElement,
    private options: InsightHistoryPaneOptions
  ) {
    this.selectedFile = options.initialFile ?? null;
    this.showingList = !options.initialFile;
  }

  /** 把历史列表画进宿主容器。标题由洞察页自己的顶栏负责。 */
  mount(): void {
    this.bindCompactQuery();
    this.host.empty();
    this.component.load();
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.records = await loadInsightRecords(this.app, this.options.settings);
    } catch (error) {
      console.error("[Mote] Failed to load insights:", error);
      this.records = [];
    }
    this.loading = false;
    if (!this.records.some((record) => record.file === this.selectedFile)) {
      this.selectedFile = this.records[0]?.file ?? null;
    }
    this.render();
  }

  unmount(): void {
    this.renderSeq++;
    this.compactQuery?.removeEventListener("change", this.onCompactChange);
    this.compactQuery = null;
    this.hostObserver?.disconnect();
    this.hostObserver = null;
    this.stopConfirmTimer();
    dismissCitationPreview();
    this.component.unload();
    this.host.empty();
  }

  /** 窄屏阅读正文时，返回先回到列表。已经在列表上则交给页面退出历史。 */
  backToList(): boolean {
    if (!this.isCompact() || this.showingList || this.loading) return false;
    if (this.records.length === 0) return false;
    this.showingList = true;
    this.render();
    this.host
      .querySelector(".memoria-insight-history-item.is-active")
      ?.scrollIntoView({ block: "nearest" });
    return true;
  }

  private stopConfirmTimer(): void {
    if (this.confirmTimer !== null) {
      window.clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
  }

  private resetComponent(): void {
    this.component.unload();
    this.component = new Component();
    this.component.load();
  }

  private select(file: string): void {
    this.stopConfirmTimer();
    this.confirmDeleteFile = null;
    this.selectedFile = file;
    const openArticle = this.isCompact();
    this.showingList = false;
    this.render();
    if (openArticle) this.scrollPageToTop();
  }

  private bindCompactQuery(): void {
    const view = this.host.ownerDocument.defaultView;
    if (!view) return;
    this.compactQuery = view.matchMedia("(max-width: 680px)");
    this.compactQuery.addEventListener("change", this.onCompactChange);
    // 窗口够宽但面板很窄（桌面侧边 pane、iPad 分屏）时，窗口断点不会触发，
    // 只能盯面板自己的尺寸。
    this.hostObserver = new view.ResizeObserver(() => this.onCompactChange());
    this.hostObserver.observe(this.host);
  }

  private readonly onCompactChange = (): void => {
    this.render();
  };

  private isCompact(): boolean {
    return (
      this.compactQuery?.matches === true ||
      this.host.ownerDocument.body.classList.contains("is-mobile") ||
      (this.host.clientWidth > 0 && this.host.clientWidth <= 680)
    );
  }

  private scrollPageToTop(): void {
    const scroller = this.host.closest<HTMLElement>(".memoria-insight-body");
    if (scroller) scroller.scrollTop = 0;
  }

  private requestDelete(file: string, button: HTMLButtonElement): void {
    if (this.confirmDeleteFile !== file) {
      this.confirmDeleteFile = file;
      this.stopConfirmTimer();
      // 就地切换按钮，不重渲染整块详情：否则正文异步重排，确认态会迟到且滚动位置丢失
      this.setDeleteArmed(button, true);
      this.confirmTimer = window.setTimeout(() => {
        this.confirmDeleteFile = null;
        this.confirmTimer = null;
        if (button.isConnected) this.setDeleteArmed(button, false);
      }, 3000);
      return;
    }
    this.stopConfirmTimer();
    this.confirmDeleteFile = null;
    const record = this.records.find((item) => item.file === file);
    if (record) {
      void deleteInsightRecord(this.app, record).catch((error: unknown) => {
        console.error("[Mote] Failed to delete insight:", error);
      });
      this.records = this.records.filter((item) => item.file !== file);
      this.selectedFile =
        this.selectedFile === file
          ? (this.records[0]?.file ?? null)
          : this.selectedFile;
    }
    this.render();
  }

  private setDeleteArmed(button: HTMLButtonElement, armed: boolean): void {
    const label = armed
      ? t("insight.history.confirmDelete")
      : t("insight.history.delete");
    button.toggleClass("is-confirm", armed);
    button.setAttr("title", label);
    button.setAttr("aria-label", label);
    const existing = button.querySelector(".memoria-insight-doc-action-label");
    if (armed) {
      if (!existing) {
        button.createSpan({
          cls: "memoria-insight-doc-action-label",
          text: label,
        });
      }
    } else {
      existing?.remove();
    }
  }

  private render(): void {
    this.host.empty();
    const shell = this.host.createDiv({ cls: "memoria-insight-history" });

    if (this.loading) {
      const loading = shell.createDiv({
        cls: "memoria-insight-history-loading",
        attr: { role: "status" },
      });
      const spinner = loading.createSpan({ cls: "memoria-insight-spinner" });
      setIcon(spinner, "loader-2");
      loading.createSpan({ text: t("insight.history.loading") });
      return;
    }

    if (this.records.length === 0) {
      const empty = shell.createDiv({ cls: "memoria-insight-history-empty" });
      const icon = empty.createDiv({
        cls: "memoria-insight-history-empty-icon",
      });
      setIcon(icon, "history");
      empty.createDiv({
        cls: "memoria-insight-history-empty-title",
        text: t("insight.history.empty"),
      });
      return;
    }

    if (!this.records.some((record) => record.file === this.selectedFile)) {
      this.selectedFile = this.records[0].file;
    }

    const compact = this.isCompact();
    const showList = !compact || this.showingList;
    const showDetail = !compact || !this.showingList;
    if (compact) shell.addClass(this.showingList ? "is-picking" : "is-reading");

    const body = shell.createDiv({ cls: "memoria-insight-history-body" });
    if (!showList) {
      const detail = body.createDiv({ cls: "memoria-insight-history-detail" });
      const record = this.records.find((item) => item.file === this.selectedFile);
      if (record) void this.renderDetail(detail, record);
      return;
    }

    const list = body.createDiv({ cls: "memoria-insight-history-list" });
    for (const record of this.records) {
      const item = list.createEl("button", {
        cls:
          "memoria-insight-history-item" +
          (record.file === this.selectedFile ? " is-active" : ""),
        attr: {
          type: "button",
          "aria-pressed": String(record.file === this.selectedFile),
        },
      });
      item.createSpan({
        cls: "memoria-insight-history-item-title",
        text: record.title,
      });
      const meta = item.createSpan({
        cls: "memoria-insight-history-item-meta",
      });
      if (record.perspectiveLabel) {
        meta.createSpan({
          cls: "memoria-insight-history-item-kind",
          text: record.perspectiveLabel,
        });
      }
      const createdAt = formatCreatedAt(record);
      if (createdAt) meta.createSpan({ text: createdAt });
      item.addEventListener("click", () => this.select(record.file));
    }

    if (!showDetail) return;
    const detail = body.createDiv({ cls: "memoria-insight-history-detail" });
    const record = this.records.find(
      (item) => item.file === this.selectedFile
    );
    if (record) void this.renderDetail(detail, record);
  }

  private async renderDetail(
    parent: HTMLElement,
    record: InsightRecord
  ): Promise<void> {
    const seq = ++this.renderSeq;
    const createdAt = formatCreatedAt(record);

    renderDocHead(parent, {
      title: record.title,
      meta: {
        kind: record.perspectiveLabel,
        items: [
          createdAt,
          record.noteCount > 0
            ? t("insight.history.noteCount", { n: record.noteCount })
            : "",
        ].filter(Boolean),
      },
    });

    if (record.scopeDescription) {
      parent.createDiv({
        cls: "memoria-insight-doc-scope",
        text: record.scopeDescription,
      });
    }

    this.resetComponent();
    await renderDocBody({
      app: this.app,
      component: this.component,
      parent,
      markdown: stripLeadingTitle(record.markdown),
      sourcePath: record.file,
      citations: resolveCitations(this.app, record.sources),
      sourceFolder: this.options.settings.folder,
      onOpenMemo: (file) => {
        this.options.openMemo?.(file);
      },
      onOpenInsight: (file) => this.select(file),
    });
    if (seq !== this.renderSeq || !parent.isConnected) return;

    // 正文收口：分割线 + 右下角纯图标操作（复制 / 删除），与结果页同风格
    renderDocFoot(parent, [
      ...(this.options.quoteSource ? [{
        label: t("toolbar.quote"),
        icon: "quote",
        onClick: () => {
          this.options.quoteSource?.(record.file);
        },
      }] : []),
      {
        label: t("insight.history.copy"),
        icon: "copy",
        onClick: () => {
          void navigator.clipboard
            .writeText(record.markdown)
            .then(() => new Notice(t("notice.copied")))
            .catch(() => new Notice(t("insight.copyFailed")));
        },
      },
      {
        label: t("insight.history.delete"),
        icon: "trash-2",
        tone: "danger",
        onClick: (button) => this.requestDelete(record.file, button),
      },
    ]);
  }
}
