/**
 * v2.1.0: 文案池 —— 宠物气泡里偶尔说的那一句话
 *
 * 设计原则（克制三原则）：
 *   1. 不打扰：每次显示最多 1 句
 *   2. 有意义：基于真实用户行为触发
 *   3. 有人味：像朋友说的话，不要"系统消息"冷冰冰
 *
 * 文案是 Memoria 原创（不抄 Claude Code），但情境化触发借鉴了类似想法。
 */

import { Memo } from "../types";
import { t } from "../i18n";
import { HatchedBuddy } from "./hatch";

/** 选一句最贴当下情境的文案 */
export function pickQuip(buddy: HatchedBuddy, memos: Memo[]): string {
  const now = new Date();
  const hour = now.getHours();
  const todayStr = fmtDate(now);
  const todayMemos = memos.filter((m) => m.date === todayStr);

  // ===== 情境触发（优先级 1-7）=====

  // 1) 满每日目标
  if (todayMemos.length >= 5) {
    return pick("buddy.quip.goalDone", buddy);
  }

  // 2) 深夜写笔记（0-4 点）
  if (hour >= 0 && hour < 5 && todayMemos.length > 0) {
    return pick("buddy.quip.lateNight", buddy);
  }

  // 3) 久未打开
  if (memos.length > 0) {
    // v2.1.0-iter18: 用 reduce 替代 Math.max(...spread)，避免大数组栈风险
    let lastTs = 0;
    for (const m of memos) {
      const ts = m.datetime.getTime();
      if (ts > lastTs) lastTs = ts;
    }
    const daysSince = (Date.now() - lastTs) / (1000 * 60 * 60 * 24);
    if (daysSince >= 7) {
      return pick("buddy.quip.longGone", buddy);
    }
    if (daysSince >= 3) {
      return pick("buddy.quip.missYou", buddy);
    }
  }

  // 4) 凌晨 5-9 点（早起）
  if (hour >= 5 && hour < 9 && todayMemos.length > 0) {
    return pick("buddy.quip.earlyBird", buddy);
  }

  // 5) 周末（周六/周日）
  const dow = now.getDay();
  if (dow === 0 || dow === 6) {
    return pick("buddy.quip.weekend", buddy);
  }

  // 6) 今天写过笔记
  if (todayMemos.length > 0) {
    return pick("buddy.quip.wroteToday", buddy);
  }

  // 7) 今天还没写
  return pick("buddy.quip.idle", buddy);
}

/** v2.1.0-iter5: 从候选池里随机选一条（扩容到每池 6 条候选）。
 *   之前按小时稳定（一小时内刷新不换），但用户反馈"每次打开 OB 都想看到不同的"，
 *   改成纯随机，候选池也从 3 条扩到 6 条避免重复感。*/
function pick(baseKey: string, buddy: HatchedBuddy): string {
  const candidates = [
    `${baseKey}.0`, `${baseKey}.1`, `${baseKey}.2`,
    `${baseKey}.3`, `${baseKey}.4`, `${baseKey}.5`,
  ];
  // 纯随机
  const idx = Math.floor(Math.random() * candidates.length);
  return t(candidates[idx]);
}

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
