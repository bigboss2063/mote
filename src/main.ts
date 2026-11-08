// ================= Memoria 插件入口 =================

import {
  ObsidianProtocolData,
  Platform,
  Plugin,
  TFile,
  WorkspaceLeaf,
  Notice,
} from "obsidian";
import {
  DEFAULT_SETTINGS,
  MemoriaSettings,
  VIEW_TYPE_MEMORIA,
  VIEW_TYPE_MEMORIA_STATS,
  VIEW_TYPE_MEMORIA_YEAR,
  VIEW_TYPE_MEMORIA_INSIGHT,
} from "./types";
import { MemoStore } from "./store";
import { MemoriaView } from "./view";
import { MemoriaSettingTab } from "./settings";
import { StatsView } from "./stats";
import { YearPanoramaView } from "./year-panorama";
import { InsightView } from "./ai/insight-view";
import { openInsightPage } from "./ai/insight-open";
import { DEFAULT_SCOPE_FILTER, describeScopeFilter } from "./ai/scope";
import { initLocale, t } from "./i18n";
import { createMainLeaf, openMemoriaView } from "./workspace";

export default class MemoriaPlugin extends Plugin {
  settings!: MemoriaSettings;
  store!: MemoStore;
  private unloaded = false;

  async onload(): Promise<void> {
    this.unloaded = false;
    await this.loadSettings();

    // v2.0.0: 初始化多语言（根据 settings.language）
    initLocale(this.settings.language);

    this.store = new MemoStore(this.app, this.settings);

    // 注册视图
    this.registerView(
      VIEW_TYPE_MEMORIA,
      (leaf: WorkspaceLeaf) => new MemoriaView(leaf, this.store, this.settings, this)
    );
    this.registerView(
      VIEW_TYPE_MEMORIA_STATS,
      (leaf: WorkspaceLeaf) => new StatsView(leaf, this.store, this.settings)
    );
    this.registerView(
      VIEW_TYPE_MEMORIA_YEAR,
      (leaf: WorkspaceLeaf) => new YearPanoramaView(leaf, this.store, this.settings)
    );
    this.registerView(
      VIEW_TYPE_MEMORIA_INSIGHT,
      (leaf: WorkspaceLeaf) => new InsightView(leaf, this.store, this.settings)
    );

    // Ribbon 按钮
    this.addRibbonIcon("feather", t("ribbon.openMote"), () => {
      void this.activateView();
    });

    // 命令
    this.addCommand({
      id: "open-memoria",
      name: t("command.openMote"),
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "open-memoria-stats",
      name: t("command.openStats"),
      callback: () => {
        void this.activateStatsView();
      },
    });

    this.addCommand({
      id: "open-memoria-year",
      name: t("command.openYear"),
      callback: () => {
        void this.activateYearView();
      },
    });

    this.addCommand({
      id: "open-memoria-insight",
      name: t("command.openInsight"),
      callback: () => {
        void this.activateInsightView();
      },
    });

    this.addCommand({
      id: "memoria-quick-capture",
      name: t("command.quickCapture"),
      callback: () => {
        void this.quickCapture();
      },
    });

    // iOS Shortcuts / external apps:
    //   obsidian://memoria-capture?vault=<vault>&content=<encoded text>
    // Obsidian decodes query values before invoking the handler.
    this.registerObsidianProtocolHandler(
      "memoria-capture",
      (params: ObsidianProtocolData) => {
        void this.handleProtocolCapture(params);
      }
    );

    // 文件变化监听
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f instanceof TFile && this.store.isInFolder(f)) {
          void this.store.reloadFile(f).catch((err: unknown) => {
            console.error("[Mote] Failed to reload modified note:", err);
          });
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => {
        if (f instanceof TFile) this.store.removeFile(f.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (f) => {
        // Vault initialization emits create for existing files, including attachments.
        if (!this.app.workspace.layoutReady) return;
        if (f instanceof TFile && this.store.isInFolder(f)) {
          void this.store.reloadFile(f).catch((err: unknown) => {
            console.error("[Mote] Failed to load created note:", err);
          });
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, old) => {
        this.store.removeFile(old);
        if (f instanceof TFile && this.store.isInFolder(f)) {
          void this.store.reloadFile(f).catch((err: unknown) => {
            console.error("[Mote] Failed to reload renamed note:", err);
          });
        }
      })
    );

    this.addSettingTab(new MemoriaSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      // One Markdown-only scan also populates restored statistics/calendar views.
      void this.store.reloadAll().catch((err: unknown) => {
        console.error("[Mote] Failed to load notes after startup:", err);
      });
      if (!this.settings.openOnStartup) return;
      void this.activateView().catch((err: unknown) => {
        console.error("[Mote] Failed to open on startup:", err);
      });
    });
  }

  onunload(): void {
    this.unloaded = true;
    // 由 Obsidian 自动清理视图
  }

  async loadSettings(): Promise<void> {
    const loaded: unknown = await this.loadData();
    const persisted =
      typeof loaded === "object" && loaded !== null
        ? (loaded as Partial<MemoriaSettings>)
        : {};
    this.settings = { ...DEFAULT_SETTINGS, ...persisted };
    if (!["main", "left", "right"].includes(this.settings.openLocation)) {
      this.settings.openLocation = "main";
    }
    this.settings.sidebarCollapsed = this.settings.sidebarCollapsed === true;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // v2.0.0: language 可能被改，重新同步 i18n 状态
    initLocale(this.settings.language);
  }

  getCaptureUriTemplate(): string {
    const vault = encodeURIComponent(this.app.vault.getName());
    return `obsidian://memoria-capture?vault=${vault}&content=`;
  }

  async activateView(): Promise<void> {
    await openMemoriaView(this.app, this.settings);
  }

  private async activateCaptureView(): Promise<void> {
    const leaf = await openMemoriaView(this.app, this.settings);
    if (leaf.view instanceof MemoriaView) {
      leaf.view.openCaptureInput();
    }
  }

  async activateStatsView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_MEMORIA_STATS
    );
    if (existing.length) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = createMainLeaf(this.app);
    await leaf.setViewState({
      type: VIEW_TYPE_MEMORIA_STATS,
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  async activateYearView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_MEMORIA_YEAR
    );
    if (existing.length) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = createMainLeaf(this.app);
    await leaf.setViewState({
      type: VIEW_TYPE_MEMORIA_YEAR,
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  async activateInsightView(): Promise<void> {
    if (!this.settings.aiEnabled) {
      new Notice(t("insight.setup.disabled"));
      return;
    }
    const existing = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_MEMORIA_INSIGHT
    );
    if (existing.length) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    await openInsightPage(this.app, {
      scopeMemos: this.store.getAll(),
      scopeFilter: { ...DEFAULT_SCOPE_FILTER },
      scopeDescription: describeScopeFilter(DEFAULT_SCOPE_FILTER),
    });
  }

  private async quickCapture(): Promise<void> {
    // Mobile already has a keyboard-safe FAB input card. Reuse it instead of
    // opening the desktop modal, which iOS WebView can place behind the IME.
    if (Platform.isMobile) {
      await this.activateCaptureView();
      return;
    }

    // v1.1.15: 防重复打开 —— 连按两次 Ctrl+Shift+M 之前会挂两层 backdrop，
    //   第一次关只能关最上层，底下一层变成拦截所有点击的"幽灵蒙版"。
    const existing = activeDocument.querySelector(
      ".memoria-modal-backdrop"
    );
    if (existing) {
      const ta0 = existing.querySelector<HTMLTextAreaElement>("textarea");
      if (ta0) ta0.focus();
      return;
    }

    const backdrop = activeDocument.createElement("div");
    backdrop.addClass("memoria-modal-backdrop");
    const box = backdrop.createDiv({ cls: "memoria-modal" });
    box.createDiv({
      cls: "memoria-modal-title",
      text: t("quickCapture.title"),
    });
    const ta = box.createEl("textarea", {
      cls: "memoria-modal-textarea",
      attr: { placeholder: t("quickCapture.placeholder") },
    });
    const btnRow = box.createDiv({ cls: "memoria-modal-btns" });
    const cancel = btnRow.createEl("button", { text: t("quickCapture.cancel") });
    const save = btnRow.createEl("button", {
      text: t("quickCapture.send"),
      cls: "mod-cta",
    });
    activeDocument.body.appendChild(backdrop);

    // v1.1.15: 插件卸载 / 禁用时自动清理弹窗（避免残留蒙版和 listener）
    // v1.4.11: 同时清理 mousedown 里挂出的全局 mouseup listener（见下方 pendingMouseUp）
    let pendingMouseUp: ((ev: MouseEvent) => void) | null = null;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (pendingMouseUp) {
        activeDocument.removeEventListener("mouseup", pendingMouseUp, true);
        pendingMouseUp = null;
      }
      backdrop.remove();
    };
    this.register(() => {
      close();
    });
    window.setTimeout(() => ta.focus(), 20);

    // v1.1.10: textarea 高度自适应（和主输入框行为一致）
    const autoResize = () => {
      ta.setCssStyles({ height: "auto" });
      ta.setCssStyles({ height: `${ta.scrollHeight + 2}px` });
    };
    ta.addEventListener("input", autoResize);
    window.setTimeout(autoResize, 0);

    const submit = async () => {
      const text = ta.value.trim();
      if (!text) {
        close();
        return;
      }
      try {
        await this.store.addMemo(text);
        new Notice(t("notice.saved"));
        close();
      } catch (e) {
        new Notice(t("notice.saveFailed", { msg: (e as Error).message }));
      }
    };

    cancel.addEventListener("click", close);
    // v1.1.10 bug 修复: 原用 `click` 判定 target === backdrop 会把
    //   "在 textarea 右下角 resize 拖拽时松手到 backdrop 上" 误判为点击，
    //   导致速记弹窗无故消失。改为更严格的 mousedown 起点判定 —— 只有
    //   "按下时就在 backdrop 自身"（不是从 box / textarea 拖出来的）才关闭。
    // v1.4.11: 原实现每次 mousedown 都 activeDocument.addEventListener("mouseup",...)
    //   如果 mousedown 后用户把鼠标拖出浏览器窗口松手，mouseup 拿不到事件，
    //   这个 listener 就永久挂在 activeDocument 上。现在用 pendingMouseUp 作为 slot，
    //   新的 mousedown 覆盖前会先清理上一个。
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) {
        // 清掉可能遗留的上一个 mouseup
        if (pendingMouseUp) {
          activeDocument.removeEventListener("mouseup", pendingMouseUp, true);
        }
        const up = (ev: MouseEvent) => {
          activeDocument.removeEventListener("mouseup", up, true);
          pendingMouseUp = null;
          if (ev.target === backdrop) close();
        };
        pendingMouseUp = up;
        activeDocument.addEventListener("mouseup", up, true);
      }
    });
    ta.addEventListener("keydown", (e) => {
      // v2.0.17: 按用户设置的 sendHotkey 决定发送键，两种模式完全互斥
      //   - enter 模式：仅纯 Enter 发送（含 IME 保护）+ Shift+Enter 换行；Ctrl+Enter 不响应
      //   - ctrl-enter 模式：仅 Ctrl/Cmd+Enter 发送；纯 Enter 换行
      const mode = this.settings.sendHotkey;
      if (e.key === "Enter") {
        const isMod = e.ctrlKey || e.metaKey;
        const isShift = e.shiftKey;
        if (mode === "enter" && !isMod && !isShift) {
          // 纯 Enter：IME 组合态下是"确认候选"，不发送
          if (!e.isComposing) {
            e.preventDefault();
            void submit();
            return;
          }
        } else if (mode === "ctrl-enter" && isMod && !isShift) {
          e.preventDefault();
          void submit();
          return;
        }
      }
      // 其他 IME 组合态按键直接放过
      if (e.isComposing) {
        return;
      }
      if (e.key === "Escape") {
        close();
      }
    });
    save.addEventListener("click", () => {
      void submit();
    });
  }

  private async handleProtocolCapture(
    params: ObsidianProtocolData
  ): Promise<void> {
    const content =
      typeof params.content === "string"
        ? params.content
        : typeof params.text === "string"
          ? params.text
          : "";

    if (!content.trim()) {
      await this.quickCapture();
      return;
    }

    try {
      await this.store.addMemo(content);
      new Notice(t("notice.protocolCaptureSaved"));
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : t("error.unknown");
      console.error("[Mote] URI capture failed:", error);
      new Notice(t("notice.protocolCaptureFailed", { msg: message }));
    }
  }
}
