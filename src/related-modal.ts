// ================= 相关笔记弹窗 =================
// 由主视图传入计算函数与语义索引状态；本文件只负责把结果画出来、
// 在语义索引后台补齐时刷新，以及点击跳转。

import { App, Modal } from "obsidian";
import type { Memo } from "./types";
import type { RelatedItem } from "./ai/related";
import type { SemanticIndex } from "./ai/embedding";
import { cleanMemoText } from "./ai/retrieve";
import { t } from "./i18n";

export class RelatedNotesModal extends Modal {
  private listEl: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private refreshTimer: number | null = null;

  constructor(
    app: App,
    private host: {
      semantic: SemanticIndex;
      items: () => RelatedItem[];
      openMemo: (memo: Memo) => void;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("related.title"));
    this.modalEl.addClass("memoria-related-modal");
    this.listEl = this.contentEl.createDiv({ cls: "memoria-related-list" });
    this.footerEl = this.contentEl.createDiv({ cls: "memoria-related-foot" });
    this.unsubscribe = this.host.semantic.onUpdate(() => this.scheduleRefresh());
    this.render();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.contentEl.empty();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.render();
    }, 400);
  }

  private render(): void {
    if (!this.listEl || !this.footerEl) return;
    const items = this.host.items();
    this.listEl.empty();

    if (items.length === 0) {
      this.listEl.createDiv({
        cls: "memoria-related-empty",
        text: t("related.empty"),
      });
    }
    for (const item of items) this.renderItem(item);
    this.renderFooter();
  }

  private renderItem(item: RelatedItem): void {
    const list = this.listEl;
    if (!list) return;
    const row = list.createDiv({ cls: "memoria-related-item" });
    row.addEventListener("click", () => {
      this.close();
      this.host.openMemo(item.memo);
    });

    const meta = row.createDiv({ cls: "memoria-related-meta" });
    meta.createSpan({
      cls: "memoria-related-date",
      text: `${item.memo.date} ${item.memo.time}`,
    });

    row.createDiv({
      cls: "memoria-related-text",
      text: cleanMemoText(item.memo.content, 160),
    });

    const reasons = row.createDiv({ cls: "memoria-related-reasons" });
    const chip = (text: string, cls = ""): void => {
      reasons.createSpan({ cls: `memoria-related-chip ${cls}`.trim(), text });
    };
    for (const tag of item.reasons.tags) chip(`#${tag}`, "is-tag");
    for (const term of item.reasons.terms) chip(term);
    if (item.reasons.link === "out") chip(t("related.reason.out"), "is-link");
    if (item.reasons.link === "in") chip(t("related.reason.in"), "is-link");
    if (item.reasons.link === "both") chip(t("related.reason.both"), "is-link");
    if (item.reasons.semantic) chip(t("related.reason.semantic"), "is-semantic");
  }

  private renderFooter(): void {
    if (!this.footerEl) return;
    this.footerEl.empty();
    const status = this.host.semantic.status();
    if (status.state === "off") {
      this.footerEl.setText(t("related.semantic.off"));
      return;
    }
    if (status.state === "idle") {
      this.footerEl.setText(t("related.semantic.idle"));
      return;
    }
    if (status.state === "syncing") {
      this.footerEl.setText(
        t("related.semantic.syncing", {
          done: String(status.done),
          total: String(status.total),
        })
      );
      return;
    }
    if (status.state === "error") {
      this.footerEl.setText(
        t("related.semantic.error", { msg: status.error ?? "" })
      );
      return;
    }
    this.footerEl.setText(t("related.semantic.ready", { n: String(status.count) }));
  }
}
