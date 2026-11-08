import { App, View } from "obsidian";
import type { Memo } from "../types";
import { VIEW_TYPE_MEMORIA_INSIGHT } from "../types";
import { createMainLeaf } from "../workspace";
import type { InsightScopeFilter } from "./scope";

/** 打开洞察页时带上的范围。页面已经存在时直接套用，避免再叠一个弹窗。 */
export interface InsightSession {
  seed?: Memo;
  scopeMemos: Memo[];
  scopeFilter?: InsightScopeFilter;
  scopeDescription: string;
  historyFile?: string;
  /** 页面已打开时只切到历史，不重置当前范围和结果。 */
  keepCurrent?: boolean;
}

export interface InsightSessionHost {
  applySession(session: InsightSession): void;
  showHistory(file?: string): void;
}

let pendingSession: InsightSession | null = null;

export function takeInsightSession(): InsightSession | null {
  const session = pendingSession;
  pendingSession = null;
  return session;
}

function isInsightHost(view: View): view is View & InsightSessionHost {
  const host = view as View & Partial<InsightSessionHost>;
  return (
    view.getViewType() === VIEW_TYPE_MEMORIA_INSIGHT &&
    typeof host.applySession === "function" &&
    typeof host.showHistory === "function"
  );
}

export async function openInsightPage(
  app: App,
  session: InsightSession
): Promise<void> {
  const existing = app.workspace.getLeavesOfType(VIEW_TYPE_MEMORIA_INSIGHT)[0];
  if (existing && isInsightHost(existing.view)) {
    if (session.historyFile && session.keepCurrent) {
      existing.view.showHistory(session.historyFile);
    } else {
      existing.view.applySession(session);
    }
    await app.workspace.revealLeaf(existing);
    return;
  }

  pendingSession = session;
  const leaf = createMainLeaf(app);
  await leaf.setViewState({
    type: VIEW_TYPE_MEMORIA_INSIGHT,
    active: true,
  });
  await app.workspace.revealLeaf(leaf);
}
