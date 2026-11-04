// ================= 统计报告（作为 Obsidian 标签页打开） =================

import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import {
  Memo,
  RESERVED_TAGS,
  MemoriaSettings,
  VIEW_TYPE_MEMORIA_STATS,
} from "./types";
import type { MemoStore } from "./store";
import { t } from "./i18n";
import { MemoriaView } from "./view";
import { openMemoriaView } from "./workspace";

export class StatsView extends ItemView {
  private memos: Memo[] = [];
  private unsubscribe: (() => void) | null = null;
  private workspaceLeafEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, private store: MemoStore, private settings: MemoriaSettings) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_MEMORIA_STATS;
  }

  getDisplayText(): string {
    return t("stats.title");
  }

  getIcon(): string {
    return "bar-chart-3";
  }

  async onOpen(): Promise<void> {
    this.workspaceLeafEl = this.contentEl.closest(".workspace-leaf");
    this.workspaceLeafEl?.addClass("memoria-stats-workspace-leaf");
    this.contentEl.addClass("memoria-stats-view");
    this.memos = this.store.getAll();
    this.render();
    this.unsubscribe = this.store.onChange(() => {
      this.memos = this.store.getAll();
      this.render();
    });
  }

  async onClose(): Promise<void> {
    this.workspaceLeafEl?.removeClass("memoria-stats-workspace-leaf");
    this.workspaceLeafEl = null;
    if (this.unsubscribe) this.unsubscribe();
  }

  private render(): void {
    const contentEl = this.contentEl;
    contentEl.empty();

    const titleEl = contentEl.createDiv({ cls: "mstat-pagetitle" });
    titleEl.createSpan({
      cls: "mstat-pagetitle-text",
      text: t("stats.title"),
    });

    if (this.memos.length === 0) {
      contentEl.createEl("p", {
        text: t("stats.empty"),
        cls: "mstat-empty-page",
      });
      return;
    }

    const body = contentEl.createDiv({ cls: "memoria-stats-body" });
    const sections: Array<[string, () => void]> = [
      ["overview", () => this.renderOverview(body)],
      ["year-heatmap", () => this.renderYearHeatmap(body)],
      ["top-tags", () => this.renderTopTags(body)],
      ["writing-rhythm", () => this.renderWritingRhythm(body)],
      ["tag-cloud", () => this.renderTagCloud(body)],
    ];
    for (const [name, renderSection] of sections) {
      this.renderSectionSafely(name, renderSection);
    }
  }

  private renderSectionSafely(name: string, renderSection: () => void): void {
    try {
      renderSection();
    } catch (error) {
      console.error(`[Mote] Failed to render stats section: ${name}`, error);
    }
  }

  // -------- 总览 --------
  private renderOverview(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "mstat-section" });
    const row = section.createDiv({ cls: "mstat-overview" });

    const totalWords = this.countWords(this.memos);
    const days = new Set(this.memos.map((m) => m.date)).size;
    const firstDay = [...this.memos].sort(
      (a, b) => a.datetime.getTime() - b.datetime.getTime()
    )[0];
    const spanDays =
      Math.floor(
        (Date.now() - firstDay.datetime.getTime()) / (1000 * 60 * 60 * 24)
      ) + 1;

    this.renderBigNum(row, this.memos.length, t("stats.label.memos"));
    this.renderBigNum(row, totalWords, t("stats.label.words"));
    this.renderBigNum(row, days, t("stats.label.activeDays"));
    this.renderBigNum(row, spanDays, t("stats.label.spanDays"));
  }

  private countWords(memos: Memo[]): number {
    return memos.reduce(
      (sum, memo) => sum + memo.content.replace(/\s/g, "").length,
      0
    );
  }

  private bindActivation(
    element: HTMLElement | SVGElement,
    activate: () => void
  ): void {
    element.setAttribute("role", "button");
    element.setAttribute("tabindex", "0");
    element.addEventListener("click", activate);
    element.addEventListener("keydown", (event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate();
    });
  }

  private clearDrilldown(container: HTMLElement): void {
    container.empty();
    container.removeClass("is-visible");
  }

  private renderDrilldown(
    container: HTMLElement,
    title: string,
    memos: Memo[],
    onClose: () => void
  ): void {
    container.empty();
    container.addClass("is-visible");

    const header = container.createDiv({ cls: "mstat-drilldown-header" });
    header.createDiv({ cls: "mstat-drilldown-title", text: title });
    const close = header.createEl("button", {
      cls: "mstat-drilldown-close",
      attr: {
        "aria-label": t("stats.drilldown.close"),
        title: t("stats.drilldown.close"),
      },
    });
    setIcon(close, "x");
    close.addEventListener("click", onClose);

    const list = container.createDiv({ cls: "mstat-drilldown-list" });
    const sorted = [...memos].sort(
      (a, b) => b.datetime.getTime() - a.datetime.getTime()
    );
    for (const memo of sorted.slice(0, 6)) {
      const item = list.createEl("button", {
        cls: "mstat-drilldown-item",
        attr: {
          "aria-label": t("stats.drilldown.openMemo", {
            date: memo.date,
            time: memo.time,
          }),
        },
      });
      const meta = item.createSpan({ cls: "mstat-drilldown-meta" });
      meta.createSpan({ text: memo.date });
      meta.createSpan({ text: memo.time });
      const content = memo.content.replace(/\s+/g, " ").trim();
      item.createSpan({
        cls: "mstat-drilldown-text",
        text:
          content.length > 120
            ? `${content.slice(0, 120).trimEnd()}…`
            : content || t("stats.drilldown.emptyMemo"),
      });
      const openIcon = item.createSpan({ cls: "mstat-drilldown-open" });
      setIcon(openIcon, "arrow-up-right");
      item.addEventListener("click", () => {
        void this.jumpToDate(memo.date);
      });
    }

    if (sorted.length > 6) {
      container.createDiv({
        cls: "mstat-drilldown-more",
        text: t("stats.drilldown.more", { n: sorted.length - 6 }),
      });
    }
  }

  private async jumpToDate(date: string): Promise<void> {
    const leaf = await openMemoriaView(this.app, this.settings);
    if (leaf.view instanceof MemoriaView) leaf.view.focusOnDate(date);
  }

  private renderBigNum(parent: HTMLElement, num: number, label: string): void {
    const item = parent.createDiv({ cls: "mstat-bignum" });
    item.createDiv({
      cls: "mstat-bignum-num",
      text: num.toLocaleString(),
    });
    item.createDiv({ cls: "mstat-bignum-label", text: label });
  }

  // -------- 365 天大热力图 --------
  private renderYearHeatmap(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "mstat-section" });

    const titleRow = section.createDiv({ cls: "mstat-yh-title-row" });
    titleRow.createDiv({ cls: "mstat-title", text: t("stats.section.yearHeatmap") });

    // 年份切换器：[←] 2026 年 [→]
    const yearNav = titleRow.createDiv({ cls: "mstat-yh-year-nav" });
    const prevBtn = yearNav.createEl("button", {
      cls: "mstat-yh-year-arrow",
      attr: { "aria-label": t("stats.nav.prevYear"), title: t("stats.nav.prevYear") },
    });
    setIcon(prevBtn, "chevron-left");
    const yearBtn = yearNav.createEl("button", {
      cls: "mstat-yh-year-btn",
    });
    const nextBtn = yearNav.createEl("button", {
      cls: "mstat-yh-year-arrow",
      attr: { "aria-label": t("stats.nav.nextYear"), title: t("stats.nav.nextYear") },
    });
    setIcon(nextBtn, "chevron-right");

    let displayYear = new Date().getFullYear();
    yearBtn.setText(t("stats.yearBtn", { year: displayYear }));

    const yearSummary = section.createDiv({ cls: "mstat-year-summary" });
    yearSummary.setAttr("aria-live", "polite");
    const createYearMetric = (label: string): HTMLElement => {
      const metric = yearSummary.createDiv({ cls: "mstat-year-metric" });
      const value = metric.createDiv({ cls: "mstat-year-metric-value" });
      metric.createDiv({ cls: "mstat-year-metric-label", text: label });
      return value;
    };
    const yearMemosValue = createYearMetric(t("stats.label.memos"));
    const yearWordsValue = createYearMetric(t("stats.label.words"));
    const yearActiveDaysValue = createYearMetric(t("stats.label.activeDays"));

    // v1.1.17: 年度热力图自身宽 ~800px，窄屏必然溢出。
    //   把 wrap + monthLabels 塞到同一个滚动容器里，保持两者列对齐，独立横滚。
    const yhScroll = section.createDiv({ cls: "mstat-yh-scroll" });
    const wrap = yhScroll.createDiv({ cls: "mstat-yh-wrap" });
    const monthLabels = yhScroll.createDiv({ cls: "mstat-yh-monthlabels" });
    const heatmapDetail = section.createDiv({ cls: "mstat-drilldown" });
    let selectedDay: string | null = null;

    const clearHeatmapSelection = (): void => {
      selectedDay = null;
      wrap.querySelector(".mstat-yh-cell.is-selected")?.removeClass("is-selected");
      this.clearDrilldown(heatmapDetail);
    };

    // 月度柱状图占位（跟随年份一起渲染）
    const monthlyTitle = parent.createDiv({
      cls: "mstat-section mstat-monthly-title",
    });
    const monthlyTitleRow = monthlyTitle.createDiv({ cls: "mstat-title-row" });
    monthlyTitleRow.createDiv({ cls: "mstat-title", text: t("stats.section.monthly") });
    const monthlySubtitle = monthlyTitleRow.createDiv({
      cls: "mstat-subtitle",
    });
    const monthlyChartWrap = parent.createDiv({ cls: "mstat-monthly-wrap" });

    const render = (year: number): void => {
      wrap.empty();
      monthLabels.empty();
      clearHeatmapSelection();
      yearBtn.setText(t("stats.yearBtn", { year }));

      const yearMemos = this.memos.filter((memo) =>
        memo.date.startsWith(`${year}-`)
      );
      yearMemosValue.setText(yearMemos.length.toLocaleString());
      yearWordsValue.setText(this.countWords(yearMemos).toLocaleString());
      yearActiveDaysValue.setText(
        new Set(yearMemos.map((memo) => memo.date)).size.toLocaleString()
      );

      const dayMap = new Map<string, Memo[]>();
      for (const m of yearMemos) {
        const memosForDay = dayMap.get(m.date) ?? [];
        memosForDay.push(m);
        dayMap.set(m.date, memosForDay);
      }

      const start = new Date(year, 0, 1);
      const today = new Date();
      // v1.4.10: 即便是今年，也渲染完整 12 个月的热力图骨架（到 12/31）。
      //   之前 end = today，当年只画到今天为止，页面右下会有大片空白，
      //   看起来像是"渲染了一半没渲染完"的 bug 感。现在未来的日子照样出格子，
      //   只是 count===0 走 level-0（最浅灰底），和 GitHub / 2023 年老数据视觉一致。
      const end = new Date(year, 11, 31);
      // 用 "今天" 来判断"未来"，用于 title 提示语更准确
      const todayDateOnly = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate()
      );

      const startDow = start.getDay();
      const gridStart = new Date(start);
      gridStart.setDate(start.getDate() - startDow);

      const days = Math.floor(
        (end.getTime() - gridStart.getTime()) / (1000 * 60 * 60 * 24) + 0.5
      ) + 1;
      const weeks = Math.ceil(days / 7);

      // 月份标签：记录每个月第一次出现的周列索引（仅当年的月份）
      const monthFirstWeek: { month: number; week: number }[] = [];
      let lastMonth = -1;
      for (let w = 0; w < weeks; w++) {
        const day = new Date(gridStart);
        day.setDate(gridStart.getDate() + w * 7);
        // 跳过上一年和下一年的格子
        if (day.getFullYear() !== year) continue;
        const mo = day.getMonth();
        if (mo !== lastMonth) {
          monthFirstWeek.push({ month: mo, week: w });
          lastMonth = mo;
        }
      }

      // 渲染：用绝对定位把月份标签放到对应列位置
      const cellW = 13;
      const gap = 3;
      monthLabels.style.width = `${weeks * (cellW + gap)}px`;
      for (let i = 0; i < monthFirstWeek.length; i++) {
        const m = monthFirstWeek[i];
        const next = monthFirstWeek[i + 1];
        const spanWeeks = next ? next.week - m.week : weeks - m.week;
        // 至少跨 2 周才显示标签，避免拥挤
        if (spanWeeks < 2) continue;
        const label = monthLabels.createDiv({
          cls: "mstat-yh-mlabel",
          text: t("stats.monthShort", { m: m.month + 1 }),
        });
        label.style.left = `${m.week * (cellW + gap)}px`;
      }

      // 网格
      for (let w = 0; w < weeks; w++) {
        const col = wrap.createDiv({ cls: "mstat-yh-col" });
        for (let d = 0; d < 7; d++) {
          const day = new Date(gridStart);
          day.setDate(gridStart.getDate() + w * 7 + d);
          const key = fmtDate(day);
          const inRange = day >= start && day <= end;
          const memosForDay = dayMap.get(key) ?? [];
          const count = memosForDay.length;
          // v1.4.10: 未来的日子（当年今天之后）视觉上同 level-0，
          //   但 hover title 改成"未来"而不是"0 条"，避免误导
          const isFuture = inRange && day > todayDateOnly;
          const level = !inRange
            ? -1
            : count === 0
            ? 0
            : count < 2
            ? 1
            : count < 4
            ? 2
            : count < 7
            ? 3
            : 4;
          const cell = col.createDiv({
            cls: `mstat-yh-cell level-${level}`,
            attr: {
              title: !inRange
                ? ""
                : isFuture
                ? t("stats.heatmap.future", { date: key })
                : t("stats.heatmap.dayCount", { date: key, n: count }),
            },
          });
          if (level === -1) cell.addClass("is-outside-range");
          if (count > 0) {
            cell.addClass("is-clickable");
            cell.setAttr(
              "aria-label",
              t("stats.drilldown.day", { date: key, n: count })
            );
            this.bindActivation(cell, () => {
              if (selectedDay === key) {
                clearHeatmapSelection();
                return;
              }
              wrap
                .querySelector(".mstat-yh-cell.is-selected")
                ?.removeClass("is-selected");
              selectedDay = key;
              cell.addClass("is-selected");
              this.renderDrilldown(
                heatmapDetail,
                t("stats.drilldown.day", { date: key, n: count }),
                memosForDay,
                clearHeatmapSelection
              );
            });
          }
        }
      }

      // 月度柱状图：显示该年 1-12 月
      this.renderMonthlyForYear(monthlyChartWrap, year);
      monthlySubtitle.setText(
        t("stats.monthlyYearSum", { year, n: yearMemos.length })
      );
    };

    const switchYear = (delta: number): void => {
      const years = [
        ...new Set(this.memos.map((m) => parseInt(m.date.substring(0, 4)))),
      ].sort();
      if (years.length === 0) return;
      const idx = years.indexOf(displayYear);
      const safeIdx = idx < 0 ? 0 : idx;
      const nextIdx = (safeIdx + delta + years.length) % years.length;
      displayYear = years[nextIdx];
      render(displayYear);
    };

    prevBtn.addEventListener("click", () => switchYear(-1));
    nextBtn.addEventListener("click", () => switchYear(1));
    yearBtn.addEventListener("click", () => switchYear(1));

    render(displayYear);

    // 图例
    const legend = section.createDiv({ cls: "mstat-yh-legend" });
    legend.createSpan({ text: t("stats.legend.less") });
    for (let i = 0; i <= 4; i++) {
      legend.createDiv({ cls: `mstat-yh-cell level-${i}` });
    }
    legend.createSpan({ text: t("stats.legend.more") });
  }

  // -------- 年度月份柱状图（由 renderYearHeatmap 的 year 驱动） --------
  private renderMonthlyForYear(parent: HTMLElement, year: number): void {
    parent.empty();

    const months: { key: string; label: string; memos: Memo[] }[] = [];
    for (let i = 0; i < 12; i++) {
      months.push({
        key: `${year}-${pad(i + 1)}`,
        label: t("stats.monthShort", { m: i + 1 }),
        memos: [],
      });
    }
    for (const m of this.memos) {
      if (!m.date.startsWith(`${year}-`)) continue;
      const mi = parseInt(m.date.substring(5, 7), 10) - 1;
      months[mi].memos.push(m);
    }
    const max = Math.max(1, ...months.map((m) => m.memos.length));

    // v1.1.17: 月度 12 列柱图 ~354px 在窄屏也会溢出，给同款滚动容器
    const scrollWrap = parent.createDiv({ cls: "mstat-bar-chart-scroll" });
    const chart = scrollWrap.createDiv({ cls: "mstat-bar-chart" });
    const detail = parent.createDiv({ cls: "mstat-drilldown" });
    let selectedMonth: string | null = null;
    const clearMonthSelection = (): void => {
      selectedMonth = null;
      chart.querySelector(".mstat-bar-col.is-selected")?.removeClass("is-selected");
      this.clearDrilldown(detail);
    };
    for (const mo of months) {
      const count = mo.memos.length;
      const col = chart.createDiv({ cls: "mstat-bar-col" });
      const barWrap = col.createDiv({ cls: "mstat-bar-wrap" });
      const bar = barWrap.createDiv({
        cls:
          "mstat-bar" +
          (count === max && count > 0 ? " is-max" : "") +
          (count === 0 ? " is-empty" : ""),
      });
      // v1.1.5: 0 条月份也保留 2px 高的"空柱"，保持视觉连续性
      bar.style.height =
        count === 0 ? "2px" : `${(count / max) * 100}%`;
      bar.setAttr("title", t("stats.monthlyBarRange", { key: mo.key, n: count }));
      col.createDiv({
        cls: "mstat-bar-num" + (count === 0 ? " is-dim" : ""),
        // v1.1.5: 0 也显示数字（弱化颜色），保持"每列都有数字"的节奏感
        text: String(count),
      });
      col.createDiv({ cls: "mstat-bar-label", text: mo.label });
      if (count > 0) {
        col.addClass("is-clickable");
        col.setAttr(
          "aria-label",
          t("stats.drilldown.month", { month: mo.key, n: count })
        );
        this.bindActivation(col, () => {
          if (selectedMonth === mo.key) {
            clearMonthSelection();
            return;
          }
          chart
            .querySelector(".mstat-bar-col.is-selected")
            ?.removeClass("is-selected");
          selectedMonth = mo.key;
          col.addClass("is-selected");
          this.renderDrilldown(
            detail,
            t("stats.drilldown.month", { month: mo.key, n: count }),
            mo.memos,
            clearMonthSelection
          );
        });
      }
    }
  }

  // -------- 标签云 --------
  private renderTagCloud(parent: HTMLElement): void {
    const counter = new Map<string, number>();
    for (const m of this.memos)
      for (const t of m.tags) {
        if (RESERVED_TAGS.has(t)) continue;
        counter.set(t, (counter.get(t) ?? 0) + 1);
      }
    if (counter.size === 0) return;

    const section = parent.createDiv({ cls: "mstat-section" });
    section.createDiv({ cls: "mstat-title", text: t("stats.section.tagCloud") });

    const list = [...counter.entries()].sort((a, b) => b[1] - a[1]);
    const cloud = section.createDiv({ cls: "mstat-cloud" });

    for (const [tag, count] of list) {
      cloud.createSpan({
        cls: "mstat-cloud-tag",
        text: `#${tag}`,
        attr: { title: t("list.totalCount", { n: count }) },
      });
    }
  }

  // -------- 热门标签 --------
  private renderTopTags(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "mstat-section" });
    section.createDiv({ cls: "mstat-title", text: t("stats.section.topTags") });

    const counter = new Map<string, number>();
    for (const m of this.memos)
      for (const t of m.tags) {
        if (RESERVED_TAGS.has(t)) continue;
        counter.set(t, (counter.get(t) ?? 0) + 1);
      }
    const top = [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (top.length === 0) {
      section.createDiv({
        cls: "mstat-empty",
        text: t("stats.noTag"),
      });
      return;
    }

    const max = top[0][1];
    const list = section.createDiv({ cls: "mstat-hbar-list" });
    top.forEach(([tag, count], i) => {
      const row = list.createDiv({ cls: "mstat-hbar-row" });
      const rank = row.createDiv({ cls: "mstat-hbar-rank" });
      rank.setText(String(i + 1));
      row.createDiv({ cls: "mstat-hbar-label", text: `#${tag}` });
      const barWrap = row.createDiv({ cls: "mstat-hbar-wrap" });
      const bar = barWrap.createDiv({ cls: "mstat-hbar" });
      bar.style.width = `${(count / max) * 100}%`;
      row.createDiv({
        cls: "mstat-hbar-num",
        text: count.toString(),
      });
    });
  }

  // -------- 写作节律：小时曲线 + 星期圆点 --------
  private renderWritingRhythm(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "mstat-section" });
    const titleRow = section.createDiv({ cls: "mstat-title-row" });
    titleRow.createDiv({
      cls: "mstat-title",
      text: t("stats.section.rhythm"),
    });
    titleRow.createDiv({
      cls: "mstat-subtitle",
      text: t("stats.hourly.subtitle", { n: this.memos.length }),
    });

    const rhythmGrid = section.createDiv({ cls: "mstat-rhythm-grid" });
    this.renderSectionSafely("hourly-rhythm", () => this.renderHourlyRhythm(rhythmGrid));
    this.renderSectionSafely("weekday-rhythm", () => this.renderWeekdayRhythm(rhythmGrid));
  }

  private renderHourlyRhythm(parent: HTMLElement): void {
    const panel = parent.createDiv({ cls: "mstat-rhythm-panel mstat-rhythm-hour" });
    panel.createDiv({ cls: "mstat-rhythm-heading", text: t("stats.section.hourly") });

    const memosByHour: Memo[][] = Array.from({ length: 24 }, () => []);
    for (const m of this.memos) memosByHour[m.datetime.getHours()].push(m);
    const buckets = memosByHour.map((memos) => memos.length);
    const max = Math.max(1, ...buckets);
    const peakHour = buckets.indexOf(max);
    const peakPct = ((max / this.memos.length) * 100).toFixed(1);

    const summary = panel.createDiv({ cls: "mstat-rhythm-summary" });
    const summaryItems = [
      { label: t("stats.hourly.kpi.peak"), value: `${pad(peakHour)}:00` },
      { label: t("stats.hourly.kpi.count"), value: t("stats.hourly.countValue", { n: max }) },
      { label: t("stats.hourly.kpi.share"), value: `${peakPct}%` },
    ];
    for (const item of summaryItems) {
      const metric = summary.createDiv({ cls: "mstat-rhythm-metric" });
      metric.createDiv({ cls: "mstat-rhythm-metric-value", text: item.value });
      metric.createDiv({ cls: "mstat-rhythm-metric-label", text: item.label });
    }

    const scrollWrap = panel.createDiv({ cls: "mstat-rhythm-scroll" });
    const chartShell = scrollWrap.createDiv({ cls: "mstat-rhythm-chart-shell" });
    const yAxis = chartShell.createDiv({ cls: "mstat-rhythm-y-axis" });
    for (const value of [max, Math.round(max / 2), 0]) {
      yAxis.createSpan({ text: t("stats.hourly.axisCount", { n: value }) });
    }
    const plot = chartShell.createDiv({ cls: "mstat-rhythm-plot" });
    const svg = plot.createSvg("svg", {
      cls: "mstat-rhythm-svg",
      attr: {
        viewBox: "0 0 660 150",
        preserveAspectRatio: "none",
        role: "img",
        "aria-label": t("stats.section.hourly"),
      },
    });

    const left = 8;
    const right = 652;
    const top = 12;
    const baseline = 138;
    const plotHeight = baseline - top;
    const xAt = (hour: number): number => left + (hour / 23) * (right - left);
    const yAt = (count: number): number => baseline - (count / max) * plotHeight;

    for (const ratio of [0, 0.5, 1]) {
      const y = top + ratio * plotHeight;
      svg.createSvg("line", {
        cls: "mstat-rhythm-gridline",
        attr: { x1: left, y1: y, x2: right, y2: y },
      });
    }

    const points = buckets.map((count, hour) => [xAt(hour), yAt(count)] as const);
    const linePath = points
      .map(
        ([x, y], index) =>
          `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`
      )
      .join(" ");
    const areaPath = `M ${left} ${baseline} ${linePath.replace(/^M/, "L")} L ${right} ${baseline} Z`;

    svg.createSvg("path", {
      cls: "mstat-rhythm-area",
      attr: { d: areaPath },
    });
    svg.createSvg("path", {
      cls: "mstat-rhythm-line",
      attr: { d: linePath },
    });

    const detail = panel.createDiv({ cls: "mstat-drilldown" });
    let selectedHour: number | null = null;
    const clearHourSelection = (): void => {
      selectedHour = null;
      svg
        .querySelector(".mstat-rhythm-point-group.is-selected")
        ?.classList.remove("is-selected");
      this.clearDrilldown(detail);
    };

    points.forEach(([x, y], hour) => {
      const pointGroup = svg.createSvg("g", {
        cls: "mstat-rhythm-point-group",
        attr: {
          "aria-label": t("stats.hourly.barTip", {
            hh: pad(hour),
            n: buckets[hour],
          }),
        },
      });
      pointGroup.createSvg("circle", {
        cls: "mstat-rhythm-hit-target",
        attr: { cx: x, cy: y, r: 10 },
      });
      const point = pointGroup.createSvg("circle", {
        cls: "mstat-rhythm-point",
        attr: {
          cx: x,
          cy: y,
          r: hour === peakHour ? 4.5 : 2.5,
        },
      });
      if (hour === peakHour) point.addClass("is-peak");
      if (buckets[hour] === 0) point.addClass("is-empty");
      if (buckets[hour] > 0) {
        pointGroup.addClass("is-clickable");
        this.bindActivation(pointGroup, () => {
          if (selectedHour === hour) {
            clearHourSelection();
            return;
          }
          svg
            .querySelector(".mstat-rhythm-point-group.is-selected")
            ?.classList.remove("is-selected");
          selectedHour = hour;
          pointGroup.addClass("is-selected");
          this.renderDrilldown(
            detail,
            t("stats.drilldown.hour", {
              start: pad(hour),
              end: pad((hour + 1) % 24),
              n: buckets[hour],
            }),
            memosByHour[hour],
            clearHourSelection
          );
        });
      }
    });

    const xAxis = plot.createDiv({ cls: "mstat-rhythm-x-axis" });
    for (const hour of [0, 6, 12, 18, 23]) {
      xAxis.createSpan({ text: `${pad(hour)}:00` });
    }
    plot.createDiv({ cls: "mstat-rhythm-axis-caption", text: t("stats.hourly.axisTime") });

    const desc = panel.createDiv({ cls: "mstat-desc" });
    desc.setText(
      t("stats.hourly.peak", {
        hh: pad(peakHour),
        n: max,
        pct: peakPct,
      })
    );
    panel.appendChild(detail);
  }

  private renderWeekdayRhythm(parent: HTMLElement): void {
    const panel = parent.createDiv({ cls: "mstat-rhythm-panel mstat-rhythm-week" });
    panel.createDiv({ cls: "mstat-rhythm-heading", text: t("stats.section.weekday") });

    const labels = [
      t("stats.weekday.mon"),
      t("stats.weekday.tue"),
      t("stats.weekday.wed"),
      t("stats.weekday.thu"),
      t("stats.weekday.fri"),
      t("stats.weekday.sat"),
      t("stats.weekday.sun"),
    ];
    const buckets: number[] = Array.from({ length: 7 }, () => 0);
    for (const memo of this.memos) {
      const mondayFirstIndex = (memo.datetime.getDay() + 6) % 7;
      buckets[mondayFirstIndex]++;
    }
    const max = Math.max(1, ...buckets);
    const peakDay = buckets.indexOf(max);
    const dots = panel.createDiv({ cls: "mstat-weekday-dots" });

    buckets.forEach((count, day) => {
      const item = dots.createDiv({ cls: "mstat-weekday-item" });
      const dotWrap = item.createDiv({ cls: "mstat-weekday-dot-wrap" });
      dotWrap.createSpan({
        cls:
          "mstat-weekday-dot" +
          (day === peakDay ? " is-peak" : "") +
          (count === 0 ? " is-empty" : ""),
        attr: { title: `${labels[day]}，${count}` },
      });
      item.createDiv({ cls: "mstat-weekday-label", text: labels[day] });
      item.createDiv({ cls: "mstat-weekday-count", text: String(count) });
    });

    panel.createDiv({
      cls: "mstat-desc",
      text: t("stats.weekday.peak", {
        day: labels[peakDay],
        n: max,
        pct: ((max / this.memos.length) * 100).toFixed(1),
      }),
    });
  }

}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
