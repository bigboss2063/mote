import { App, Component, Modal, Notice, TFile, setIcon } from "obsidian";
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

export interface InsightHistoryModalOptions {
  settings: MemoriaSettings;
  /** 点引用时回到 Mote 界面。 */
  openMemo?: (file: string) => void;
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

export class InsightHistoryModal extends Modal {
  private component = new Component();
  private records: InsightRecord[] = [];
  private selectedFile: string | null = null;
  private loading = true;
  private confirmDeleteFile: string | null = null;
  private confirmTimer: number | null = null;

  constructor(app: App, private options: InsightHistoryModalOptions) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("memoria-insight-history-modal");
    this.modalEl.addClass("mod-scrollable-content");
    this.titleEl.setText(t("insight.history"));
    this.contentEl.empty();
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

  onClose(): void {
    this.stopConfirmTimer();
    dismissCitationPreview();
    this.component.unload();
    this.contentEl.empty();
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
    this.render();
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
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "memoria-insight-history" });

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

    const body = shell.createDiv({ cls: "memoria-insight-history-body" });
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
      onOpenMemo: this.options.openMemo,
    });

    // 正文收口：分割线 + 右下角纯图标操作（复制 / 删除），与结果页同风格
    renderDocFoot(parent, [
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
