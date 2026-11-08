import {
  App,
  Component,
  ItemView,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  debounce,
  setIcon,
} from "obsidian";
import { RESERVED_TAGS, VIEW_TYPE_MEMORIA_INSIGHT } from "../types";
import type { Memo, MemoriaSettings } from "../types";
import type { MemoStore } from "../store";
import { MemoriaView } from "../view";
import { openMemoriaView } from "../workspace";
import { getCurrentLocale, t } from "../i18n";
import { PERSPECTIVES, getPerspective } from "./prompt";
import {
  buildInsightPlan,
  extractInsightTitle,
  finalizeInsight,
  withNoteReferences,
} from "./insight";
import type { ReferenceLookup } from "./references";
import { requestChatCompletionRich } from "./client";
import { InsightError } from "./errors";
import type {
  ChatMessage,
  InsightPlan,
  InsightResult,
  PerspectiveId,
  StreamUpdate,
} from "./types";
import {
  DEFAULT_SCOPE_FILTER,
  InsightScopeFilter,
  ScopeType,
  describeScopeFilter,
  filterScopeMemos,
  scopeStats,
  scopeTypeLabel,
} from "./scope";
import { InsightHistoryPane } from "./history-pane";
import {
  takeInsightSession,
  type InsightSession,
} from "./insight-open";
import {
  leadingHeading,
  renderDocBody,
  renderDocFoot,
  renderDocHead,
  renderDocMeta,
  sanitizeInsightMarkdown,
} from "./document";
import { saveInsightRecord, stripLeadingTitle } from "./insight-file";
import { dismissCitationPreview } from "./citation-ui";
import { memoLinkName } from "../parser";

interface SettingsApi {
  open(): void;
  openTabById(id: string): void;
}

/** 未配置态的三种阻塞原因，顺序即检查优先级。 */
type SetupProblem = "disabled" | "missing" | "consent";

const INSIGHT_TIMEOUT_MS = 180_000;

/** Resolve a memo's wikilinks to markdown in the vault. Failures stay empty. */
function vaultReferenceLookup(app: App): ReferenceLookup {
  return {
    resolve(linkpath, sourcePath) {
      const dest = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      if (!(dest instanceof TFile) || dest.extension !== "md") return null;
      return dest.path;
    },
    async read(file) {
      const target = app.vault.getAbstractFileByPath(file);
      if (!(target instanceof TFile)) return null;
      try {
        return await app.vault.cachedRead(target);
      } catch {
        return null;
      }
    },
  };
}

const SCOPE_TYPES: ScopeType[] = [
  "all",
  "today",
  "week",
  "starred",
  "pinned",
  "todo",
  "with-image",
  "with-link",
  "no-tag",
];

function openPluginSettings(app: App): void {
  const api = (app as unknown as { setting?: SettingsApi }).setting;
  api?.open();
  api?.openTabById("mote");
  // 设置面板渲染完成后，直接定位到 AI 洞察分区
  window.setTimeout(() => {
    activeDocument
      .querySelector('[data-mote-section="ai"]')
      ?.scrollIntoView({ block: "start" });
  }, 0);
}

/** Keep streamed prose readable until the final Markdown render replaces it. */
function streamedText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

interface MenuOption {
  value: string;
  label: string;
  icon: string;
}

let closeActiveMenu: (() => void) | null = null;

function closeInsightMenu(): void {
  closeActiveMenu?.();
}

function openInsightMenu(input: {
  anchor: HTMLElement;
  options: MenuOption[];
  onSelect: (value: string) => void;
}): void {
  closeActiveMenu?.();
  const menu = activeDocument.body.createDiv({
    cls: "memoria-tag-suggest memoria-insight-menu",
  });
  menu.setAttr("role", "listbox");
  input.anchor.setAttr("aria-expanded", "true");

  let activeIndex = -1;
  const items: HTMLElement[] = [];

  const select = (value: string): void => {
    input.onSelect(value);
    close();
  };
  const refreshActive = (): void => {
    items.forEach((item, index) => {
      const active = index === activeIndex;
      item.toggleClass("active", active);
      item.setAttr("aria-selected", String(active));
    });
    items[activeIndex]?.scrollIntoView({ block: "nearest" });
  };

  for (const option of input.options) {
    const item = menu.createDiv({
      cls: "memoria-tag-suggest-item",
      attr: {
        role: "option",
        "aria-selected": "false",
      },
    });
    const icon = item.createSpan({ cls: "memoria-tag-suggest-icon" });
    setIcon(icon, option.icon);
    item.createSpan({ cls: "memoria-tag-suggest-name", text: option.label });
    item.addEventListener("click", () => select(option.value));
    items.push(item);
  }

  const close = (): void => {
    input.anchor.setAttr("aria-expanded", "false");
    activeDocument.removeEventListener("mousedown", onOutside, true);
    activeDocument.removeEventListener("keydown", onKeydown, true);
    activeDocument.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", close);
    menu.remove();
    closeActiveMenu = null;
  };

  const onOutside = (event: MouseEvent): void => {
    const target = event.target as Node;
    if (menu.contains(target) || input.anchor.contains(target)) return;
    close();
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      input.anchor.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (activeIndex < 0) {
        activeIndex = event.key === "ArrowDown" ? 0 : input.options.length - 1;
      } else {
        activeIndex =
          (activeIndex + (event.key === "ArrowDown" ? 1 : -1) +
            input.options.length) %
          input.options.length;
      }
      refreshActive();
      return;
    }
    if (event.key === "Enter" && activeIndex >= 0) {
      const option = input.options[activeIndex];
      if (option) {
        event.preventDefault();
        select(option.value);
      }
    }
  };
  const onScroll = (event: Event): void => {
    if (menu.contains(event.target as Node)) return;
    close();
  };

  const rect = input.anchor.getBoundingClientRect();
  const maxWidth = Math.min(320, window.innerWidth - 16);
  menu.addClass("is-measuring");
  menu.setCssProps({
    minWidth: `${Math.max(rect.width, 180)}px`,
    maxWidth: `${maxWidth}px`,
    left: `${Math.min(
      Math.max(8, rect.left),
      window.innerWidth - maxWidth - 8
    )}px`,
  });
  const desiredHeight = Math.min(menu.scrollHeight, 280);
  const below = window.innerHeight - rect.bottom - 8;
  const above = rect.top - 8;
  if (below < Math.min(desiredHeight, 160) && above > below) {
    menu.setCssProps({
      maxHeight: `${Math.min(280, above)}px`,
      top: `${rect.top - Math.min(desiredHeight, 280, above) - 4}px`,
    });
  } else {
    menu.setCssProps({
      maxHeight: `${Math.min(280, below)}px`,
      top: `${rect.bottom + 4}px`,
    });
  }
  menu.removeClass("is-measuring");
  refreshActive();

  closeActiveMenu = close;
  activeDocument.addEventListener("mousedown", onOutside, true);
  activeDocument.addEventListener("keydown", onKeydown, true);
  activeDocument.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", close);
}

type InsightScreen = "home" | "result" | "setup";

export class InsightView extends ItemView {
  private perspective: PerspectiveId = "insight";
  private scopeFilter: InsightScopeFilter = { ...DEFAULT_SCOPE_FILTER };
  private scopeMemos: Memo[] = [];
  private seed: Memo | undefined;
  private seedScopeDescription = "";
  private scopeOpen = false;
  /** 工作区恢复时笔记可能还没加载完，空范围先占位，数据到了再补上。 */
  private usingDefaultScope = false;
  private unsubscribe: (() => void) | null = null;

  private generating = false;
  private requestSeq = 0;
  private timer: number | null = null;
  private setupWatchTimer: number | null = null;
  private mainAbort: AbortController | null = null;
  private userStopped = false;

  private resultComponent = new Component();

  private rootEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private homeEl!: HTMLElement;
  private setupEl: HTMLElement | null = null;
  private scopeStatsEl: HTMLElement | null = null;
  private titleNameEl: HTMLElement | null = null;
  private scopeToggleBtn: HTMLButtonElement | null = null;
  private scopePanelEl!: HTMLElement;
  private perspectiveRowEl!: HTMLElement;
  private generateBtn!: HTMLButtonElement;
  private generateLabelEl: HTMLElement | null = null;

  private docEl: HTMLElement | null = null;
  private docTitleEl: HTMLElement | null = null;
  private docMetaEl: HTMLElement | null = null;
  private backBtn: HTMLButtonElement | null = null;
  private headActionsEl: HTMLElement | null = null;
  private statusEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private liveBodyEl: HTMLElement | null = null;
  private streamBodyEl: HTMLElement | null = null;
  private progressLabelEl: HTMLElement | null = null;
  private resultWrapEl!: HTMLElement;
  private historyHost: HTMLElement | null = null;
  private historyPane: InsightHistoryPane | null = null;
  private historyBtn: HTMLButtonElement | null = null;
  private screen: InsightScreen = "home";
  private screenBeforeHistory: InsightScreen = "home";

  private result: InsightResult | null = null;
  private resultPerspective: PerspectiveId | null = null;
  private resultMarkdown = "";
  private resultReasoning = "";
  private resultScopeDescription = "";
  private lastPlan: InsightPlan | null = null;

  private live: StreamUpdate = { content: "", reasoning: "" };
  private liveRaf: number | null = null;
  private startedAt = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private store: MemoStore,
    private settings: MemoriaSettings
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_MEMORIA_INSIGHT;
  }

  getDisplayText(): string {
    return t("insight.title");
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.rootEl = this.contentEl.createDiv({ cls: "memoria-insight-view" });
    const header = this.rootEl.createDiv({ cls: "memoria-insight-header" });
    this.titleEl = header.createDiv({ cls: "memoria-insight-title" });
    this.bodyEl = this.rootEl.createDiv({ cls: "memoria-insight-body" });
    this.resultComponent.load();
    this.rootEl.addEventListener("keydown", this.onKeydown);

    const session = takeInsightSession();
    if (session) this.applySession(session);
    else {
      this.applySession(this.defaultSession());
      this.usingDefaultScope = true;
    }
    this.unsubscribe = this.store.onChange(() => this.adoptLoadedNotes());
  }

  async onClose(): Promise<void> {
    this.requestSeq++;
    this.mainAbort?.abort();
    this.mainAbort = null;
    this.rootEl?.removeEventListener("keydown", this.onKeydown);
    this.stopTimer();
    this.stopSetupWatch();
    this.cancelLiveRender();
    closeInsightMenu();
    dismissCitationPreview();
    this.historyPane?.unmount();
    this.historyPane = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.resultComponent.unload();
    this.contentEl.empty();
  }

  /** 工具栏、单条笔记或命令再次打开时，复用同一个页面并换上新范围。 */
  applySession(session: InsightSession): void {
    this.usingDefaultScope = false;
    this.requestSeq++;
    this.mainAbort?.abort();
    this.mainAbort = null;
    this.generating = false;
    this.userStopped = false;
    this.stopTimer();
    this.stopSetupWatch();
    this.cancelLiveRender();
    closeInsightMenu();
    dismissCitationPreview();
    this.historyPane?.unmount();
    this.historyPane = null;
    this.seed = session.seed;
    this.seedScopeDescription = session.scopeDescription;
    this.scopeFilter = { ...(session.scopeFilter ?? DEFAULT_SCOPE_FILTER) };
    this.scopeMemos = [...session.scopeMemos];
    this.perspective = "insight";
    this.scopeOpen = false;
    this.result = null;
    this.resultPerspective = null;
    this.resultMarkdown = "";
    this.resultReasoning = "";
    this.resultScopeDescription = "";
    this.lastPlan = null;
    this.renderScreen();
    if (session.historyFile) this.showHistory(session.historyFile);
  }

  private defaultSession(): InsightSession {
    return {
      scopeMemos: this.store.getAll(),
      scopeFilter: { ...DEFAULT_SCOPE_FILTER },
      scopeDescription: describeScopeFilter(DEFAULT_SCOPE_FILTER),
    };
  }

  /** 页面被工作区恢复时，笔记索引可能晚于视图打开。 */
  private adoptLoadedNotes(): void {
    if (!this.usingDefaultScope || this.scopeMemos.length > 0) return;
    const memos = this.store.getAll();
    if (memos.length === 0) return;
    this.scopeMemos = memos;
    this.scopeFilter = { ...DEFAULT_SCOPE_FILTER };
    if (
      this.screen === "home" &&
      !this.rootEl.hasClass("is-history") &&
      this.scopeStatsEl?.isConnected
    ) {
      this.updateScopeStats();
      this.updateGenerateState();
    }
  }

  /** 按配置状态渲染整屏：未配置显示引导卡，配置完成进入洞察首页。
   *  打开设置不再离开本页，补齐配置后由引导卡自动切入首页。 */
  private renderScreen(): void {
    this.historyPane?.unmount();
    this.historyPane = null;
    this.bodyEl.removeClass("is-showing-history");
    this.bodyEl.empty();
    this.historyHost = null;
    this.setupEl = null;
    const problem = this.configProblem();
    this.renderHeader(!problem);
    this.setScreenMode("home");
    this.screen = problem ? "setup" : "home";
    if (problem) {
      this.renderSetup(problem);
    } else {
      this.renderHome();
      this.statusEl = this.bodyEl.createDiv({
        cls: "memoria-insight-status is-hidden",
        attr: { role: "status", "aria-live": "polite" },
      });
      this.progressEl = this.bodyEl.createDiv({
        cls: "memoria-insight-thinking is-hidden",
      });
      this.resultWrapEl = this.bodyEl.createDiv({
        cls: "memoria-insight-result-wrap is-hidden",
      });
      this.updateScopeStats();
      this.syncPerspectiveSelection();
      this.updateGenerateState();
    }
    this.historyHost = this.bodyEl.createDiv({
      cls: "memoria-insight-history-host is-hidden",
    });
  }

  /** 标题区：徽标 + 标题 + 范围摘要，和原来的弹窗头部同一套结构。 */
  private renderHeader(withStats: boolean): void {
    this.titleEl.empty();
    this.titleEl.addClass("memoria-insight-title");
    // 结果页的返回键放在弹窗头部最左侧，和正文标题分开
    this.backBtn = this.titleEl.createEl("button", {
      cls: "memoria-insight-back is-hidden",
      attr: { type: "button", "aria-label": t("insight.back") },
    });
    setIcon(this.backBtn, "arrow-left");
    this.backBtn.addEventListener("click", () => {
      if (this.rootEl.hasClass("is-history")) {
        if (this.historyPane?.backToList()) return;
        this.closeHistory();
      } else {
        this.showHome();
      }
    });
    setIcon(
      this.titleEl.createSpan({ cls: "memoria-insight-title-badge" }),
      "sparkles"
    );
    const text = this.titleEl.createSpan({
      cls: "memoria-insight-title-text",
    });
    this.titleNameEl = text.createSpan({
      cls: "memoria-insight-title-name",
      text: t("insight.title"),
    });
    this.scopeStatsEl = null;
    this.headActionsEl = null;
    if (withStats) {
      this.scopeStatsEl = text.createSpan({
        cls: "memoria-insight-scope-stats",
      });
    }
  }

  private renderHome(): void {
    this.homeEl = this.bodyEl.createDiv({ cls: "memoria-insight-home" });

    // 两个低频动作进头部右侧，正文直接从视角开始，不再单独占一行。
    const headActions = this.titleEl.createDiv({
      cls: "memoria-insight-head-actions",
    });
    this.headActionsEl = headActions;

    const headIconBtn = (
      cls: string,
      icon: string,
      label: string,
      onClick: () => void
    ): HTMLButtonElement => {
      const button = headActions.createEl("button", {
        cls: `memoria-insight-text-btn memoria-insight-icon-btn ${cls}`,
        attr: { type: "button", title: label, "aria-label": label },
      });
      setIcon(button.createSpan({ cls: "memoria-insight-btn-icon" }), icon);
      button.addEventListener("click", onClick);
      return button;
    };

    if (!this.seed) {
      this.scopeToggleBtn = headIconBtn(
        "memoria-insight-scope-toggle",
        "sliders-horizontal",
        t("insight.scope.modify"),
        () => this.toggleScopePanel()
      );
      this.scopeToggleBtn.setAttr("aria-expanded", "false");
      this.scopePanelEl = this.homeEl.createDiv({
        cls: "memoria-insight-scope-panel is-hidden",
      });
      this.renderScopePanel();
    }

    this.historyBtn = headIconBtn(
      "memoria-insight-history-btn",
      "history",
      t("insight.history"),
      () => this.showHistory()
    );

    headIconBtn(
      "memoria-insight-settings-btn",
      "settings",
      t("insight.openSettings"),
      () => openPluginSettings(this.app)
    );

    this.perspectiveRowEl = this.homeEl.createDiv({
      cls: "memoria-insight-perspectives",
    });
    for (const perspective of PERSPECTIVES) {
      const card = this.perspectiveRowEl.createEl("button", {
        cls: "memoria-insight-perspective",
        attr: {
          type: "button",
          "data-perspective": perspective.id,
          "aria-pressed": "false",
        },
      });
      const icon = card.createSpan({
        cls: "memoria-insight-perspective-icon",
      });
      setIcon(icon, perspective.icon);
      const text = card.createSpan({
        cls: "memoria-insight-perspective-text",
      });
      const name = text.createSpan({
        cls: "memoria-insight-perspective-name",
      });
      name.createSpan({ text: t(perspective.labelKey) });
      setIcon(
        name.createSpan({ cls: "memoria-insight-perspective-check" }),
        "check"
      );
      text.createSpan({
        cls: "memoria-insight-perspective-desc",
        text: t(perspective.descriptionKey),
      });
      card.addEventListener("click", () => {
        if (this.generating || this.perspective === perspective.id) return;
        this.perspective = perspective.id;
        this.syncPerspectiveSelection();
        this.updateGenerateState();
      });
    }

    // 底部操作条：左侧快捷键提示，右侧唯一主动作，吸附在内容底部
    const foot = this.homeEl.createDiv({ cls: "memoria-insight-foot" });
    const footHint = foot.createDiv({
      cls: "memoria-insight-foot-hint",
    });
    footHint.createEl("kbd", {
      cls: "memoria-insight-kbd",
      text: Platform.isMacOS ? "⌘↵" : "Ctrl ↵",
    });
    footHint.createSpan({
      cls: "memoria-insight-foot-hint-text",
      text: t("insight.quickGenerate"),
    });
    this.generateBtn = foot.createEl("button", {
      cls: "mod-cta",
      attr: { type: "button" },
    });
    setIcon(
      this.generateBtn.createSpan({ cls: "memoria-insight-cta-icon" }),
      "sparkles"
    );
    this.generateLabelEl = this.generateBtn.createSpan({
      text: t("insight.generate"),
    });
    this.generateBtn.addEventListener("click", () => {
      void this.generate();
    });
  }

  /** Cmd/Ctrl + Enter 直接生成，和底部提示保持一致。 */
  private onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    if (this.generating) return;
    if (!this.homeEl || this.homeEl.hasClass("is-hidden")) return;
    if (!this.generateBtn || this.generateBtn.disabled) return;
    event.preventDefault();
    void this.generate();
  };

  private renderScopePanel(): void {
    closeInsightMenu();
    this.scopePanelEl.empty();
    const head = this.scopePanelEl.createDiv({
      cls: "memoria-insight-scope-panel-head",
    });
    head.createSpan({ text: t("insight.scope.title") });
    const reset = head.createEl("button", {
      cls: "memoria-insight-text-btn memoria-insight-scope-reset",
      text: t("insight.scope.reset"),
      attr: { type: "button" },
    });
    reset.addEventListener("click", () => {
      this.scopeFilter = { ...DEFAULT_SCOPE_FILTER };
      this.renderScopePanel();
      this.applyScopeChange();
    });

    const allMemos = this.store.getAll();
    const years = Array.from(
      new Set(allMemos.map((memo) => memo.date.slice(0, 4)))
    ).sort((a, b) => (a < b ? 1 : -1));
    const tags = Array.from(
      new Set(
        allMemos.flatMap((memo) =>
          memo.tags.filter((tag) => !RESERVED_TAGS.has(tag))
        )
      )
    ).sort((a, b) => a.localeCompare(b));

    const grid = this.scopePanelEl.createDiv({
      cls: "memoria-insight-scope-grid",
    });
    const addField = (label: string, cls = ""): HTMLElement => {
      const field = grid.createDiv({
        cls: `memoria-insight-scope-field ${cls}`.trim(),
      });
      field.createSpan({
        cls: "memoria-insight-scope-label",
        text: label,
      });
      return field;
    };
    const addMenuControl = (
      field: HTMLElement,
      ariaLabel: string,
      options: MenuOption[],
      selected: string,
      onSelect: (value: string) => void
    ): void => {
      const wrap = field.createDiv({ cls: "memoria-insight-select-wrap" });
      const trigger = wrap.createEl("button", {
        cls: "memoria-insight-select-trigger",
        attr: {
          type: "button",
          "aria-haspopup": "listbox",
          "aria-expanded": "false",
          "aria-label": ariaLabel,
        },
      });
      const valueEl = trigger.createSpan({
        cls: "memoria-insight-select-value",
        text: options.find((option) => option.value === selected)?.label ?? "",
      });
      const icon = trigger.createSpan({ cls: "memoria-insight-select-icon" });
      setIcon(icon, "chevron-down");
      trigger.addEventListener("click", () => {
        openInsightMenu({
          anchor: trigger,
          options,
          onSelect: (value) => {
            selected = value;
            valueEl.setText(
              options.find((option) => option.value === value)?.label ?? ""
            );
            onSelect(value);
          },
        });
      });
    };

    const typeOptions: MenuOption[] = SCOPE_TYPES.map((type) => ({
      value: type,
      label: scopeTypeLabel(type),
      icon: "sliders-horizontal",
    }));
    const yearOptions: MenuOption[] = [
      {
        value: "",
        label: t("insight.scope.allYears"),
        icon: "calendar",
      },
      ...years.map((year) => ({
        value: year,
        label: year,
        icon: "calendar",
      })),
    ];
    const tagOptions: MenuOption[] = [
      {
        value: "",
        label: t("insight.scope.allTags"),
        icon: "hash",
      },
      ...tags.map((tag) => ({
        value: tag,
        label: tag,
        icon: "hash",
      })),
    ];

    let selectedType = this.scopeFilter.type;
    let selectedYear = this.scopeFilter.year ?? "";
    let selectedTag = this.scopeFilter.tag ?? "";
    let applyNow = (): void => {};

    const typeField = addField(t("insight.scope.type"));
    addMenuControl(
      typeField,
      t("insight.scope.type"),
      typeOptions,
      selectedType,
      (value) => {
        selectedType = value as ScopeType;
        applyNow();
      }
    );

    const yearField = addField(t("insight.scope.year"));
    addMenuControl(
      yearField,
      t("insight.scope.year"),
      yearOptions,
      selectedYear,
      (value) => {
        selectedYear = value;
        applyNow();
      }
    );

    const tagField = addField(t("insight.scope.tag"));
    addMenuControl(
      tagField,
      t("insight.scope.tag"),
      tagOptions,
      selectedTag,
      (value) => {
        selectedTag = value;
        applyNow();
      }
    );

    const dateField = addField(t("insight.scope.date"));
    const dateInput = dateField.createEl("input", {
      cls: "memoria-insight-scope-control",
      attr: {
        type: "date",
        "aria-label": t("insight.scope.date"),
      },
    });
    dateInput.value = this.scopeFilter.date ?? "";

    const keywordField = addField(
      t("insight.scope.keyword"),
      "memoria-insight-scope-keyword"
    );
    const keywordInput = keywordField.createEl("input", {
      cls: "memoria-insight-scope-control",
      attr: {
        type: "text",
        placeholder: t("insight.scope.keywordPlaceholder"),
        "aria-label": t("insight.scope.keyword"),
      },
    });
    keywordInput.value = this.scopeFilter.keyword;

    const readControls = (): InsightScopeFilter => ({
      type: selectedType,
      year: selectedYear || null,
      date: dateInput.value || null,
      tag: selectedTag || null,
      keyword: keywordInput.value.trim(),
    });
    applyNow = (): void => {
      this.scopeFilter = readControls();
      this.applyScopeChange();
    };
    const applyKeyword = debounce(applyNow, 180);

    dateInput.addEventListener("change", applyNow);
    keywordInput.addEventListener("input", applyKeyword);
  }

  private toggleScopePanel(): void {
    if (!this.scopeToggleBtn) return;
    this.scopeOpen = !this.scopeOpen;
    this.scopePanelEl.toggleClass("is-hidden", !this.scopeOpen);
    // 标签保持不变：面板展开已经足够说明状态，换文案只会让按钮左右跳动。
    this.scopeToggleBtn.toggleClass("is-open", this.scopeOpen);
    this.scopeToggleBtn.setAttr("aria-expanded", String(this.scopeOpen));
  }

  private closeScopePanel(): void {
    if (!this.scopeOpen) return;
    this.toggleScopePanel();
  }

  private applyScopeChange(): void {
    this.scopeMemos = filterScopeMemos(this.store.getAll(), this.scopeFilter);
    this.usingDefaultScope = false;
    this.updateScopeStats();
    this.updateGenerateState();
    this.syncPerspectiveSelection();
  }

  private updateScopeStats(): void {
    if (!this.scopeStatsEl) return;
    if (this.seed) {
      const date = this.seed.date;
      this.scopeStatsEl.setText(
        date
          ? t("insight.scope.singleWithDate", { date })
          : t("insight.scope.single")
      );
      return;
    }
    const stats = scopeStats(this.scopeMemos);
    if (stats.notes === 0) {
      this.scopeStatsEl.setText(t("insight.scope.empty"));
    } else {
      this.scopeStatsEl.setText(
        t("insight.scope.stats", {
          notes: stats.notes,
          tags: stats.tags,
          days: stats.days,
        })
      );
    }
    this.scopeStatsEl.toggleClass("is-empty", stats.notes === 0);
  }

  private syncPerspectiveSelection(): void {
    for (const card of Array.from(
      this.perspectiveRowEl.querySelectorAll<HTMLButtonElement>(
        "[data-perspective]"
      )
    )) {
      const active = card.dataset.perspective === this.perspective;
      card.toggleClass("is-active", active);
      card.setAttr("aria-pressed", String(active));
      card.disabled = this.generating;
    }
  }

  private updateGenerateState(): void {
    if (!this.generateBtn) return;
    const empty = !this.seed && this.scopeMemos.length === 0;
    this.generateBtn.disabled = this.generating || empty;
    if (!this.generating) {
      this.generateLabelEl?.setText(t("insight.generate"));
    }
  }

  private showHome(): void {
    if (this.generating) {
      this.requestSeq++;
      this.mainAbort?.abort();
      this.mainAbort = null;
      this.generating = false;
      this.stopTimer();
      this.cancelLiveRender();
    }
    this.result = null;
    this.resultPerspective = null;
    this.resultMarkdown = "";
    this.resultReasoning = "";
    this.resultScopeDescription = "";
    this.lastPlan = null;
    this.homeEl.removeClass("is-hidden");
    this.statusEl.empty();
    this.statusEl.removeClass("is-error", "is-banner", "is-empty-state");
    this.statusEl.addClass("is-hidden");
    this.progressEl.addClass("is-hidden");
    this.resultWrapEl.empty();
    this.resultWrapEl.addClass("is-hidden");
    this.streamBodyEl = null;
    this.clearDoc();
    this.setScreenMode("home");
    this.screen = "home";
    if (this.historyBtn) this.historyBtn.disabled = false;
    this.syncPerspectiveSelection();
    this.updateGenerateState();
    this.bodyEl.scrollTop = 0;
  }

  /** 结果页把页头收成一条窄导航：只留返回。
   *  品牌标题与"调整范围 / 洞察历史"在这个页面不再出现。
   *  离开本页由工作区自己的返回/关闭完成。 */
  private setScreenMode(mode: "home" | "result" | "history"): void {
    this.rootEl.toggleClass("is-result", mode === "result");
    this.rootEl.toggleClass("is-history", mode === "history");
    this.backBtn?.toggleClass("is-hidden", mode === "home");
    this.headActionsEl?.toggleClass("is-hidden", mode !== "home");
    this.scopeStatsEl?.toggleClass("is-hidden", mode !== "home");
    this.titleNameEl?.setText(
      mode === "history" ? t("insight.history") : t("insight.title")
    );
  }

  /** 结果页和历史详情共用同一套"文档视图"：标题 + 元信息 + 动作 + 正文。
   *  流式阶段先立好骨架，标题先用视角名占位，正文边出边填。 */
  private showResultScreen(): void {
    this.homeEl.addClass("is-hidden");
    this.statusEl.addClass("is-hidden");
    this.setScreenMode("result");
    this.screen = "result";
    this.bodyEl.scrollTop = 0;

    this.resultWrapEl.empty();
    this.resultWrapEl.removeClass("is-hidden");
    this.docEl = this.resultWrapEl.createDiv({ cls: "memoria-insight-doc" });
    const head = renderDocHead(this.docEl, {
      title: t(getPerspective(this.perspective).labelKey),
    });
    this.docTitleEl = head.titleEl;
    this.docMetaEl = head.metaEl;
    this.streamBodyEl = this.docEl.createDiv({
      cls: "memoria-insight-result memoria-insight-streaming",
    });
  }

  private clearDoc(): void {
    this.docEl = null;
    this.docTitleEl = null;
    this.docMetaEl = null;
  }

  private configProblem(): SetupProblem | null {
    if (!this.settings.aiEnabled) return "disabled";
    if (!this.settings.aiBaseUrl.trim() || !this.settings.aiModel.trim()) {
      return "missing";
    }
    if (!this.settings.aiConsent) return "consent";
    return null;
  }

  /** 配置清单：三项前置条件的当前状态，让缺口一眼可见。 */
  private configChecks(): { label: string; done: boolean }[] {
    return [
      {
        label: t("insight.setup.check.enable"),
        done: this.settings.aiEnabled,
      },
      {
        label: t("insight.setup.check.endpoint"),
        done: Boolean(this.settings.aiBaseUrl.trim()) &&
          Boolean(this.settings.aiModel.trim()),
      },
      {
        label: t("insight.setup.check.consent"),
        done: this.settings.aiConsent,
      },
    ];
  }

  /** 未配置态：居中的引导卡（徽标 + 标题 + 说明 + 配置清单 + CTA），
   *  沿用标题徽标、范围面板与主按钮的同一套视觉词汇。 */
  private renderSetup(problem: SetupProblem): void {
    this.setupEl = this.bodyEl.createDiv({ cls: "memoria-insight-setup" });
    const box = this.setupEl;
    const icon = box.createDiv({ cls: "memoria-insight-setup-icon" });
    setIcon(icon, "settings-2");
    box.createEl("p", {
      cls: "memoria-insight-setup-title",
      text: t(`insight.setup.${problem}`),
    });
    box.createEl("p", {
      cls: "memoria-insight-setup-desc",
      text: t(`insight.setup.${problem}Desc`),
    });

    const list = box.createDiv({ cls: "memoria-insight-setup-list" });
    for (const check of this.configChecks()) {
      const item = list.createDiv({
        cls: `memoria-insight-setup-item${check.done ? " is-done" : ""}`,
      });
      const mark = item.createSpan({ cls: "memoria-insight-setup-item-mark" });
      setIcon(mark, check.done ? "check" : "circle");
      item.createSpan({
        cls: "memoria-insight-setup-item-label",
        text: check.label,
      });
    }

    const button = box.createEl("button", {
      cls: "mod-cta",
      attr: { type: "button" },
    });
    setIcon(
      button.createSpan({ cls: "memoria-insight-cta-icon" }),
      "settings"
    );
    button.createSpan({ text: t("insight.setup.openSettings") });
    // 不关闭本弹窗：设置面板叠在上方，配置完成后自动切入洞察首页
    button.addEventListener("click", () => {
      openPluginSettings(this.app);
    });

    this.startSetupWatch();
  }

  /** 设置面板叠在本弹窗上方时，用户可能随时补齐配置；
   *  周期复查，配置一完成就自动切入洞察首页。 */
  private startSetupWatch(): void {
    this.stopSetupWatch();
    this.setupWatchTimer = window.setInterval(() => {
      if (this.configProblem()) return;
      this.stopSetupWatch();
      this.renderScreen();
    }, 400);
  }

  private stopSetupWatch(): void {
    if (this.setupWatchTimer !== null) {
      window.clearInterval(this.setupWatchTimer);
      this.setupWatchTimer = null;
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private cancelLiveRender(): void {
    if (this.liveRaf !== null) {
      window.cancelAnimationFrame(this.liveRaf);
      this.liveRaf = null;
    }
  }

  private setInfo(message: string): void {
    this.statusEl.empty();
    this.statusEl.removeClass("is-error", "is-banner", "is-empty-state");
    this.statusEl.removeClass("is-hidden");
    this.statusEl.setText(message);
  }

  /** 错误态按「周围是否已有内容」分流（对应设计稿方案 A / B）：
   *  - 结果区没有任何内容 → 居中错误空态（方案 A），单一主操作「重试」；
   *  - 首页可见或已有部分结果 → 置顶内联警示条（方案 B），不打断下方内容阅读。 */
  private renderError(error: unknown, retryable = true): void {
    const message = this.errorMessage(error);
    const homeVisible = this.homeEl && !this.homeEl.hasClass("is-hidden");
    const streamed = this.streamBodyEl?.textContent?.trim() ?? "";
    const rendered =
      this.docEl?.querySelector(".memoria-insight-doc-body")?.textContent?.trim() ??
      "";
    const hasContent = Boolean(streamed || rendered);

    this.statusEl.empty();
    this.statusEl.removeClass("is-hidden");
    this.statusEl.addClass("is-error");

    if (homeVisible || hasContent) {
      // 方案 B：内联警示条，行内完成重试
      this.statusEl.addClass("is-banner");
      this.statusEl.removeClass("is-empty-state");
      const banner = this.statusEl.createDiv({
        cls: "memoria-insight-error-banner",
      });
      const left = banner.createDiv({
        cls: "memoria-insight-error-banner-main",
      });
      setIcon(
        left.createSpan({ cls: "memoria-insight-error-banner-icon" }),
        "alert-circle"
      );
      left.createSpan({
        cls: "memoria-insight-error-banner-msg",
        text: message,
      });
      if (retryable) {
        const retry = banner.createEl("button", {
          cls: "memoria-insight-error-banner-retry",
          attr: { type: "button", title: t("insight.retry") },
        });
        setIcon(
          retry.createSpan({ cls: "memoria-insight-cta-icon" }),
          "refresh-cw"
        );
        retry.createSpan({ text: t("insight.retry") });
        retry.addEventListener("click", () => {
          void this.generate();
        });
      }
      return;
    }

    // 方案 A：居中错误空态，视线聚焦单一主操作
    this.statusEl.addClass("is-empty-state");
    this.statusEl.removeClass("is-banner");
    const box = this.statusEl.createDiv({
      cls: "memoria-insight-error-empty",
    });
    const badge = box.createDiv({
      cls: "memoria-insight-error-empty-badge",
    });
    setIcon(badge, "alert-circle");
    box.createEl("p", {
      cls: "memoria-insight-error-empty-title",
      text: t("insight.error.title"),
    });
    box.createEl("p", {
      cls: "memoria-insight-error-empty-desc",
      text: message,
    });
    if (retryable) {
      const retry = box.createEl("button", {
        cls: "mod-cta",
        attr: { type: "button" },
      });
      setIcon(
        retry.createSpan({ cls: "memoria-insight-cta-icon" }),
        "refresh-cw"
      );
      retry.createSpan({ text: t("insight.retry") });
      retry.addEventListener("click", () => {
        void this.generate();
      });
      box.createEl("p", {
        cls: "memoria-insight-error-empty-hint",
        text: t("insight.error.hint"),
      });
    }
  }

  private errorMessage(error: unknown): string {
    if (!(error instanceof InsightError)) {
      const message = error instanceof Error ? error.message : String(error);
      return t("insight.error.unknown", { msg: message });
    }
    switch (error.code) {
      case "empty_scope":
        return t("insight.error.emptyScope");
      case "unauthorized":
        return t("insight.error.unauthorized");
      case "not_found":
        return t("insight.error.notFound");
      case "rate_limited":
        return t("insight.error.rateLimited");
      case "server":
        return t("insight.error.server");
      case "network":
        return t("insight.error.network");
      case "timeout":
        return t("insight.error.timeout");
      case "empty":
        return t("insight.error.empty");
      case "context":
        return t("insight.error.context");
      case "aborted":
        return t("insight.stopped");
      case "config":
        return t("insight.setup.missing");
      default:
        return t("insight.error.unknown", {
          msg: error.detail || error.message,
        });
    }
  }

  private resetResultState(): void {
    this.result = null;
    this.resultPerspective = null;
    this.resultMarkdown = "";
    this.resultReasoning = "";
    this.resultScopeDescription = "";
    this.lastPlan = null;
    this.live = { content: "", reasoning: "" };
    this.resultWrapEl.empty();
    this.resultWrapEl.addClass("is-hidden");
    this.progressEl.empty();
    this.progressEl.addClass("is-hidden");
    this.liveBodyEl = null;
    this.streamBodyEl = null;
    this.clearDoc();
    this.progressLabelEl = null;
    this.statusEl.empty();
    this.statusEl.removeClass("is-error", "is-banner", "is-empty-state");
    this.statusEl.addClass("is-hidden");
  }

  private async generate(): Promise<void> {
    if (this.generating) return;
    const problem = this.configProblem();
    if (problem) {
      this.renderError(new InsightError("config"), false);
      return;
    }
    if (!this.seed && this.scopeMemos.length === 0) {
      this.renderError(new InsightError("empty_scope"), false);
      return;
    }

    this.generating = true;
    this.userStopped = false;
    const seq = ++this.requestSeq;
    this.closeScopePanel();
    this.resetResultState();
    this.generateBtn.disabled = true;
    if (this.historyBtn) this.historyBtn.disabled = true;
    this.syncPerspectiveSelection();

    let plan: InsightPlan;
    try {
      const input = {
        seed: this.seed,
        scopeMemos: this.scopeMemos,
        allMemos: this.store.getAll(),
        perspective: this.perspective,
        scopeDescription: this.seed
          ? this.seedScopeDescription
          : describeScopeFilter(this.scopeFilter),
        locale: getCurrentLocale(),
      };
      plan = await withNoteReferences(
        buildInsightPlan(input),
        input,
        vaultReferenceLookup(this.app)
      );
    } catch (error) {
      this.generating = false;
      this.generateBtn.disabled = false;
      if (this.historyBtn) this.historyBtn.disabled = false;
      this.syncPerspectiveSelection();
      this.updateGenerateState();
      this.renderError(error, false);
      return;
    }

    this.lastPlan = plan;
    this.resultScopeDescription = this.seed
      ? this.seedScopeDescription
      : describeScopeFilter(this.scopeFilter);
    this.showResultScreen();
    this.renderProgress();

    const controller = new AbortController();
    this.mainAbort = controller;
    try {
      const completion = await this.runCompletion(
        plan.messages,
        controller,
        (update) => this.onStreamUpdate(update)
      );
      if (seq !== this.requestSeq) return;

      const result = finalizeInsight(completion.content, plan.notes);
      this.result = result;
      this.resultPerspective = this.perspective;
      this.resultMarkdown = sanitizeInsightMarkdown(result.markdown);
      this.resultReasoning = completion.reasoning;
      this.hideProgress();
      await this.renderResult(result, plan);
      await this.saveHistory(result, plan);
    } catch (error) {
      if (seq !== this.requestSeq) return;
      this.stopTimer();
      this.cancelLiveRender();
      const aborted =
        error instanceof InsightError && error.code === "aborted";
      if (aborted && this.userStopped) {
        const partial = this.live.content.trim();
        if (partial) {
          const result = finalizeInsight(partial, plan.notes);
          this.result = result;
          this.resultPerspective = this.perspective;
          this.resultMarkdown = sanitizeInsightMarkdown(result.markdown);
          this.resultReasoning = this.live.reasoning;
          this.hideProgress();
          this.setInfo(t("insight.stoppedPartial"));
          await this.renderResult(result, plan);
        } else {
          this.showHome();
          new Notice(t("insight.stopped"));
        }
      } else {
        const partial = this.live.content.trim();
        if (partial) {
          // 方案 B 场景：保留已生成的部分结果，警示条置顶提示失败
          const result = finalizeInsight(partial, plan.notes);
          this.result = result;
          this.resultPerspective = this.perspective;
          this.resultMarkdown = sanitizeInsightMarkdown(result.markdown);
          this.resultReasoning = this.live.reasoning;
          this.hideProgress();
          await this.renderResult(result, plan);
          if (seq === this.requestSeq) this.renderError(error);
        } else {
          // 方案 A 场景：无任何内容，清空结果区后展示居中错误空态
          this.progressEl.addClass("is-hidden");
          this.progressEl.empty();
          this.resultWrapEl.empty();
          this.resultWrapEl.addClass("is-hidden");
          this.streamBodyEl = null;
          this.renderError(error);
        }
      }
    } finally {
      if (seq === this.requestSeq) {
        this.stopTimer();
        this.mainAbort = null;
        this.generating = false;
        if (this.historyBtn) this.historyBtn.disabled = false;
        this.syncPerspectiveSelection();
        this.updateGenerateState();
      }
    }
  }

  private async runCompletion(
    messages: ChatMessage[],
    controller: AbortController,
    onUpdate: (update: StreamUpdate) => void
  ): Promise<{
    content: string;
    reasoning: string;
    durationMs: number;
    streamed: boolean;
  }> {
    const started = Date.now();
    let timeoutId = 0;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => {
        controller.abort();
        reject(new InsightError("timeout"));
      }, INSIGHT_TIMEOUT_MS);
    });
    try {
      const completion = await Promise.race([
        requestChatCompletionRich(
          {
            baseUrl: this.settings.aiBaseUrl,
            apiKey: this.settings.aiApiKey,
            model: this.settings.aiModel,
            messages,
          },
          { signal: controller.signal, onUpdate }
        ),
        timeout,
      ]);
      return { ...completion, durationMs: Date.now() - started };
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
    }
  }

  private onStreamUpdate(update: StreamUpdate): void {
    this.live = update;
    if (this.liveRaf !== null) return;
    this.liveRaf = window.requestAnimationFrame(() => {
      this.liveRaf = null;
      this.renderLiveText();
    });
  }

  private renderProgress(): void {
    this.stopTimer();
    this.progressEl.empty();
    this.progressEl.removeClass("is-hidden");
    const head = this.progressEl.createDiv({
      cls: "memoria-insight-thinking-head",
    });
    const spinner = head.createSpan({ cls: "memoria-insight-spinner" });
    setIcon(spinner, "loader-2");
    this.progressLabelEl = head.createSpan({
      cls: "memoria-insight-thinking-label",
    });
    const stop = head.createEl("button", {
      cls: "memoria-insight-stop",
      text: t("insight.stop"),
      attr: { type: "button" },
    });
    stop.addEventListener("click", () => {
      this.userStopped = true;
      stop.disabled = true;
      stop.setText(t("insight.stopping"));
      this.mainAbort?.abort();
    });
    this.liveBodyEl = this.progressEl.createDiv({
      cls: "memoria-insight-thinking-body is-hidden",
    });
    this.startedAt = Date.now();
    this.updateProgressLabel();
    this.timer = window.setInterval(() => this.updateProgressLabel(), 1000);
  }

  private updateProgressLabel(): void {
    if (!this.progressLabelEl) return;
    const seconds = Math.max(
      0,
      Math.floor((Date.now() - this.startedAt) / 1000)
    );
    this.progressLabelEl.setText(t("insight.thinking", { seconds }));
  }

  private renderLiveText(): void {
    const reasoning = this.live.reasoning.trim();
    if (reasoning && this.liveBodyEl) {
      const body = this.liveBodyEl;
      const stickToBottom =
        body.scrollHeight - body.scrollTop - body.clientHeight < 48;
      body.setText(reasoning);
      body.removeClass("is-hidden");
      body.addClass("has-text");
      if (stickToBottom) body.scrollTop = body.scrollHeight;
    }

    const content = this.live.content.trim();
    if (content && this.streamBodyEl) {
      const stickToBottom =
        this.bodyEl.scrollHeight -
          this.bodyEl.scrollTop -
          this.bodyEl.clientHeight <
        64;
      // 模型开头就是 `# 标题`：边流边把标题顶到头部，正文里不再重复一遍。
      const heading = leadingHeading(content);
      if (heading && this.docTitleEl) this.docTitleEl.setText(heading);
      this.streamBodyEl.setText(streamedText(stripLeadingTitle(content)));
      // 流式光标：紧跟正文尾部的强调色游标，提示仍在生成
      this.streamBodyEl.createSpan({ cls: "memoria-insight-caret" });
      if (stickToBottom) this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
    }
  }

  /** 生成结束后收起过程区：结论本身已经说明结果，不再多一行状态文案。 */
  private hideProgress(): void {
    this.stopTimer();
    this.cancelLiveRender();
    this.progressEl.empty();
    this.progressEl.addClass("is-hidden");
    this.liveBodyEl = null;
    this.progressLabelEl = null;
  }

  private async renderResult(
    result: InsightResult,
    plan: InsightPlan
  ): Promise<void> {
    const doc = this.docEl;
    if (!doc) return;

    const stream = this.streamBodyEl;
    this.streamBodyEl = null;
    stream?.remove();

    const kindLabel = t(
      getPerspective(this.resultPerspective ?? this.perspective).labelKey
    );
    this.docTitleEl?.setText(extractInsightTitle(result.markdown, kindLabel));
    if (this.docMetaEl) {
      renderDocMeta(this.docMetaEl, {
        kind: kindLabel,
        items: [t("insight.history.noteCount", { n: plan.notes.length })],
      });
    }

    // 思考过程折叠条放在正文上方；没有思考过程就整条隐藏。
    if (this.resultReasoning.trim()) {
      this.renderReasoning(doc);
    }

    this.resultComponent.unload();
    this.resultComponent = new Component();
    this.resultComponent.load();
    await renderDocBody({
      app: this.app,
      component: this.resultComponent,
      parent: doc,
      markdown: sanitizeInsightMarkdown(stripLeadingTitle(result.markdown)),
      sourcePath: plan.notes[0]?.memo.file ?? "",
      citations: result.sources.map((source) => ({
        id: source.id,
        file: source.memo.file,
      })),
      sourceFolder: this.settings.folder,
      onOpenMemo: (file) => {
        void this.openSourceMemo(file);
      },
      onOpenInsight: (file) => this.showHistory(file),
    });
    if (!this.resultWrapEl.isConnected) return;

    // 正文收口：分割线 + 右下角纯图标操作（复制 / 重新生成）
    renderDocFoot(doc, [
      {
        label: t("insight.copy"),
        icon: "copy",
        onClick: () => void this.copyResult(),
      },
      {
        label: t("insight.regenerate"),
        icon: "refresh-cw",
        onClick: () => void this.generate(),
      },
    ]);
  }

  private renderReasoning(parent: HTMLElement): void {
    const block = parent.createDiv({ cls: "memoria-insight-reasoning" });
    const toggle = block.createEl("button", {
      cls: "memoria-insight-reasoning-toggle",
      attr: { type: "button", "aria-expanded": "false" },
    });
    toggle.createSpan({ text: t("insight.showThinking") });
    setIcon(
      toggle.createSpan({ cls: "memoria-insight-btn-icon" }),
      "chevron-down"
    );
    const body = block.createDiv({
      cls: "memoria-insight-reasoning-body is-hidden",
      text: this.resultReasoning.trim(),
    });
    toggle.addEventListener("click", () => {
      const hidden = body.hasClass("is-hidden");
      body.toggleClass("is-hidden", !hidden);
      toggle.setAttr("aria-expanded", String(hidden));
      toggle.toggleClass("is-open", hidden);
    });
  }

  private async saveHistory(
    result: InsightResult,
    plan: InsightPlan
  ): Promise<void> {
    if (!this.resultPerspective) return;
    const title = extractInsightTitle(
      this.resultMarkdown,
      t(getPerspective(this.resultPerspective).labelKey)
    );
    try {
      await saveInsightRecord(this.app, this.settings, {
        createdAt: Date.now(),
        title,
        perspectiveLabel: t(getPerspective(this.resultPerspective).labelKey),
        scopeDescription: this.resultScopeDescription,
        noteCount: plan.notes.length,
        markdown: sanitizeInsightMarkdown(result.markdown),
        sources: result.sources.map((source) => memoLinkName(source.memo.file)),
      });
    } catch (error) {
      console.error("[Mote] Failed to save insight:", error);
    }
  }

  /** 历史和结果叠在同一页里：底下的首页或结果还在，返回时原样露出来。 */
  showHistory(file?: string): void {
    this.stopSetupWatch();
    if (!this.rootEl.hasClass("is-history")) {
      this.screenBeforeHistory = this.screen;
    }
    this.bodyEl.addClass("is-showing-history");
    this.setScreenMode("history");
    const host = this.ensureHistoryHost();
    host.removeClass("is-hidden");
    this.historyPane?.unmount();
    this.historyPane = new InsightHistoryPane(this.app, host, {
      settings: this.settings,
      initialFile: file,
      openMemo: (path) => {
        void this.openSourceMemo(path);
      },
      quoteSource: (path) => {
        void this.quoteSourceFile(path);
      },
    });
    this.historyPane.mount();
    this.bodyEl.scrollTop = 0;
  }

  private closeHistory(): void {
    this.historyPane?.unmount();
    this.historyPane = null;
    this.historyHost?.empty();
    this.historyHost?.addClass("is-hidden");
    this.bodyEl.removeClass("is-showing-history");
    const previous = this.screenBeforeHistory;
    this.screen = previous;
    this.setScreenMode(previous === "result" ? "result" : "home");
    if (previous === "setup") this.startSetupWatch();
    this.bodyEl.scrollTop = 0;
  }

  private ensureHistoryHost(): HTMLElement {
    if (!this.historyHost?.isConnected) {
      this.historyHost = this.bodyEl.createDiv({
        cls: "memoria-insight-history-host is-hidden",
      });
    }
    return this.historyHost;
  }

  private async openSourceMemo(file: string): Promise<void> {
    const leaf = await openMemoriaView(this.app, this.settings);
    if (leaf.view instanceof MemoriaView) leaf.view.revealMemo({ file });
  }

  private async quoteSourceFile(file: string): Promise<void> {
    const leaf = await openMemoriaView(this.app, this.settings);
    if (leaf.view instanceof MemoriaView) leaf.view.quoteSource(file);
  }

  private async copyResult(): Promise<void> {
    if (!this.resultMarkdown) return;
    try {
      await navigator.clipboard.writeText(this.resultMarkdown);
      new Notice(t("notice.copied"));
    } catch {
      new Notice(t("insight.copyFailed"));
    }
  }
}
