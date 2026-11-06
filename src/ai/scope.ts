import type { Memo } from "../types";
import { RESERVED_TAGS } from "../types";
import { matchesQuery, parseSearchQuery } from "../search";
import { getCurrentLocale, t } from "../i18n";

export type ScopeType =
  | "all"
  | "today"
  | "week"
  | "no-tag"
  | "with-image"
  | "with-link"
  | "pinned"
  | "starred"
  | "todo";

export interface InsightScopeFilter {
  type: ScopeType;
  year: string | null;
  date: string | null;
  tag: string | null;
  keyword: string;
}

export const DEFAULT_SCOPE_FILTER: InsightScopeFilter = {
  type: "all",
  year: null,
  date: null,
  tag: null,
  keyword: "",
};

export interface ScopeStats {
  notes: number;
  tags: number;
  days: number;
}

const TYPE_LABEL_KEYS: Record<ScopeType, string> = {
  all: "sidebar.all",
  today: "sidebar.today",
  week: "sidebar.week",
  "no-tag": "sidebar.noTag",
  "with-image": "sidebar.withImage",
  "with-link": "sidebar.withLink",
  pinned: "sidebar.pinned",
  starred: "sidebar.starred",
  todo: "sidebar.todo",
};

export function scopeTypeLabel(type: ScopeType): string {
  return t(TYPE_LABEL_KEYS[type]);
}

function fmtDateLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function weekStart(date: Date): Date {
  const monday = new Date(date);
  const dow = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - dow);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/** The same filter semantics as the main list (preset, year, date, tag,
 *  advanced keyword query), applied to a local copy for AI insight scopes. */
export function filterScopeMemos(
  memos: Memo[],
  filter: InsightScopeFilter,
  now = new Date()
): Memo[] {
  const query = parseSearchQuery(filter.keyword);
  const today = fmtDateLocal(now);
  const monday = weekStart(now).getTime();

  return memos.filter((memo) => {
    if (filter.year && !memo.date.startsWith(filter.year)) return false;
    if (filter.date && memo.date !== filter.date) return false;
    if (
      filter.tag &&
      !memo.tags.some(
        (tag) => tag === filter.tag || tag.startsWith(`${filter.tag}/`)
      )
    ) {
      return false;
    }

    switch (filter.type) {
      case "today":
        if (memo.date !== today) return false;
        break;
      case "week":
        if (memo.datetime.getTime() < monday) return false;
        break;
      case "no-tag":
        if (memo.tags.some((tag) => !RESERVED_TAGS.has(tag))) return false;
        break;
      case "with-image":
        if (!memo.hasImage) return false;
        break;
      case "with-link":
        if (!memo.hasLink) return false;
        break;
      case "pinned":
        if (!memo.isPinned) return false;
        break;
      case "starred":
        if (!memo.isStarred) return false;
        break;
      case "todo":
        if (!memo.hasOpenTask) return false;
        break;
      case "all":
        break;
    }

    return matchesQuery(memo.content, memo.tags, memo.date, query);
  });
}

export function scopeStats(memos: Memo[]): ScopeStats {
  const tags = new Set<string>();
  const days = new Set<string>();
  for (const memo of memos) {
    days.add(memo.date);
    for (const tag of memo.tags) {
      if (!RESERVED_TAGS.has(tag)) tags.add(tag);
    }
  }
  return { notes: memos.length, tags: tags.size, days: days.size };
}

export function hasScopeFilter(filter: InsightScopeFilter): boolean {
  return (
    filter.type !== "all" ||
    filter.year !== null ||
    filter.date !== null ||
    filter.tag !== null ||
    filter.keyword.trim() !== ""
  );
}

export function scopeFilterKey(filter: InsightScopeFilter): string {
  return JSON.stringify([
    filter.type,
    filter.year,
    filter.date,
    filter.tag,
    filter.keyword.trim(),
  ]);
}

export function describeScopeFilter(filter: InsightScopeFilter): string {
  const parts: string[] = [];
  if (filter.type !== "all") parts.push(scopeTypeLabel(filter.type));
  if (filter.year) parts.push(filter.year);
  if (filter.date) parts.push(filter.date);
  if (filter.tag) parts.push(`#${filter.tag}`);
  if (filter.keyword.trim()) parts.push(`「${filter.keyword.trim()}」`);
  const separator = getCurrentLocale() === "en-US" ? ", " : "，";
  return parts.length ? parts.join(separator) : t("sidebar.all");
}
