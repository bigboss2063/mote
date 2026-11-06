// ================= 数据存储层 =================
// 一条 memo 一个文件：读取 -> 解析，新增 -> 建文件，编辑 -> 改文件，
// 改时间 -> 重命名文件（Obsidian 会自动更新全库 `[[链接]]`）。

import { App, TFile, normalizePath } from "obsidian";
import { Memo, MemoriaSettings, PIN_TAG, STAR_TAG } from "./types";
import {
  memoFileInfo,
  memoFilePath,
  parseMemoFile,
  stripMemoTags,
  fmtDate,
  fmtTime,
  normalizeMemoBody,
} from "./parser";
import { t } from "./i18n";

export class MemoStore {
  private memos: Memo[] = [];
  private listeners: Array<() => void> = [];
  private loading = false;
  /** 同一文件集中触发多次变更时，合并成最多「正在跑 + 一次待跑」。 */
  private reloadLocks = new Map<string, { running: boolean; pending: boolean }>();

  constructor(private app: App, private settings: MemoriaSettings) {}

  /** 订阅数据变更 */
  onChange(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== cb);
    };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** 仅触发监听器重渲染，不改动 memos 数据（设置项变更后刷 UI 用）。 */
  notifyChange(): void {
    this.emit();
  }

  getAll(): Memo[] {
    return this.memos;
  }

  /** 扫描 folder 下的所有 memo 文件，重建列表（并行读取）。 */
  async reloadAll(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const files = this.collectFiles();
      const parsed = await Promise.all(
        files.map(async (f) => parseMemoFile(f.path, await this.app.vault.read(f)))
      );
      const result = parsed.filter((memo): memo is Memo => memo !== null);
      this.sortMemos(result);
      this.memos = result;
      this.emit();
    } finally {
      this.loading = false;
    }
  }

  /** 文件内容变化时重载单个文件 */
  async reloadFile(file: TFile): Promise<void> {
    if (!this.isInFolder(file)) return;
    const key = file.path;
    const existing = this.reloadLocks.get(key);
    if (existing && existing.running) {
      existing.pending = true;
      return;
    }
    const state = { running: true, pending: false };
    this.reloadLocks.set(key, state);
    try {
      do {
        state.pending = false;
        // 文件可能在排队期间被删除或改名，重读前再取一次
        const current = this.app.vault.getAbstractFileByPath(key);
        if (!(current instanceof TFile) || !this.isInFolder(current)) break;
        const fresh = parseMemoFile(current.path, await this.app.vault.read(current));
        this.memos = this.memos.filter((m) => m.file !== current.path);
        if (fresh) this.memos.push(fresh);
        this.sortMemos(this.memos);
        this.emit();
      } while (state.pending);
    } finally {
      this.reloadLocks.delete(key);
    }
  }

  /** 指定文件从 memo 列表中移除 */
  removeFile(path: string): void {
    const before = this.memos.length;
    this.memos = this.memos.filter((m) => m.file !== path);
    if (this.memos.length !== before) this.emit();
  }

  /** 排序：置顶优先 → 时间倒序 → 路径倒序（同一分钟里后加的在前面）。 */
  private sortMemos(arr: Memo[]): void {
    arr.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      const dt = b.datetime.getTime() - a.datetime.getTime();
      if (dt !== 0) return dt;
      const an = a.file.replace(/\.md$/, "");
      const bn = b.file.replace(/\.md$/, "");
      if (an === bn) return 0;
      return an < bn ? 1 : -1;
    });
  }

  private collectFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => this.isInFolder(f));
  }

  /** folder 下、文件名符合 memo 规则的文件才算 memo；`_` 开头的目录（回收站、洞察）整体跳过。 */
  isInFolder(file: TFile): boolean {
    if (file.extension.toLowerCase() !== "md") return false;
    const folder = normalizePath(this.settings.folder);
    if (!file.path.startsWith(`${folder}/`)) return false;
    const relative = file.path.slice(folder.length + 1);
    if (relative.split("/").some((segment) => segment.startsWith("_"))) return false;
    return memoFileInfo(file.path) !== null;
  }

  /** 创建一条新 memo。同一分钟已有文件时追加 .01 / .02 序号。 */
  async addMemo(content: string, when: Date = new Date()): Promise<void> {
    const body = normalizeMemoBody(content);
    if (!body) return;

    const folder = normalizePath(this.settings.folder);
    const date = fmtDate(when);
    const time = fmtTime(when);
    await this.ensureFolder(folder);
    await this.ensureFolder(`${folder}/${date.slice(0, 4)}`);

    let path = memoFilePath(folder, date, time);
    for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) {
      path = memoFilePath(folder, date, time, i);
    }
    const file = await this.app.vault.create(path, `${body}\n`);
    await this.reloadFile(file);
  }

  /** 直接改写这条 memo 的文件内容。 */
  async editMemo(memo: Memo, newContent: string): Promise<void> {
    const body = normalizeMemoBody(newContent);
    if (!body) return;
    const file = this.app.vault.getAbstractFileByPath(memo.file);
    if (!(file instanceof TFile)) throw new Error(t("error.originNotFound"));
    await this.app.vault.modify(file, `${body}\n`);
    await this.reloadFile(file);
  }

  /** 修改一条 memo 的时间（可同时改正文）：改文件名即改时间。 */
  async editMemoDateTime(
    memo: Memo,
    newDateTime: Date,
    newContent?: string
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(memo.file);
    if (!(file instanceof TFile)) throw new Error(t("error.originNotFound"));

    const body = normalizeMemoBody(newContent ?? memo.content);
    if (!body) throw new Error(t("error.emptyContent"));

    const date = fmtDate(newDateTime);
    const time = fmtTime(newDateTime);
    if (date === memo.date && time === memo.time) {
      if (body !== memo.content) await this.editMemo(memo, body);
      return;
    }

    const folder = normalizePath(this.settings.folder);
    await this.ensureFolder(folder);
    await this.ensureFolder(`${folder}/${date.slice(0, 4)}`);

    let path = memoFilePath(folder, date, time);
    for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) {
      path = memoFilePath(folder, date, time, i);
    }

    if (body !== memo.content) await this.app.vault.modify(file, `${body}\n`);
    // renameFile 会顺带更新全库里指向这个文件的 [[链接]]
    await this.app.fileManager.renameFile(file, path);
    this.removeFile(memo.file);
    const renamed = this.app.vault.getAbstractFileByPath(path);
    if (renamed instanceof TFile) await this.reloadFile(renamed);
  }

  /** 删除 memo：默认把文件移到 `_trash/`，关闭回收站则直接删。 */
  async deleteMemo(memo: Memo): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(memo.file);
    if (!(file instanceof TFile)) throw new Error(t("error.originNotFound"));
    if (this.settings.useTrash) {
      await this.moveToTrash(file);
    } else {
      await this.app.fileManager.trashFile(file);
    }
    this.removeFile(memo.file);
  }

  private async moveToTrash(file: TFile): Promise<void> {
    const folder = normalizePath(this.settings.folder);
    const trashFolder = `${folder}/_trash`;
    await this.ensureFolder(trashFolder);
    let path = `${trashFolder}/${file.name}`;
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) {
      path = `${trashFolder}/${file.basename} ${i}.md`;
    }
    await this.app.fileManager.renameFile(file, path);
  }

  /** 切换置顶（追加/移除 #置顶 标签） */
  async togglePinned(memo: Memo): Promise<void> {
    await this.toggleReservedTag(memo, PIN_TAG);
  }

  /** 切换收藏（追加/移除 #收藏 标签） */
  async toggleStarred(memo: Memo): Promise<void> {
    await this.toggleReservedTag(memo, STAR_TAG);
  }

  private async toggleReservedTag(memo: Memo, tag: string): Promise<void> {
    const has = memo.tags.includes(tag);
    let newContent: string;
    if (has) {
      newContent = stripMemoTags(memo.content, new Set([tag])).text;
      newContent = newContent
        .split("\n")
        .map((l) => l.replace(/[ \t]+$/, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      // 去完后什么都不剩时给个占位内容，保证笔记仍然可见、可再编辑；
      // 真想删掉笔记请走"删除"菜单，而不是通过取消置顶/收藏隐式删除。
      if (newContent === "") {
        newContent = `（已取消${tag}）`;
      }
    } else {
      const lines = memo.content.split("\n");
      if (lines.length === 0 || lines[0].trim() === "") {
        lines[0] = `#${tag}`;
      } else {
        lines[0] = `${lines[0].replace(/\s+$/, "")} #${tag}`;
      }
      newContent = lines.join("\n");
    }
    await this.editMemo(memo, newContent);
  }

  /**
   * 保存二进制图片到附件目录
   * 文件名：mote-YYYYMMDD-HHmmss-随机.<ext>
   */
  async saveImageAttachment(
    bytes: ArrayBuffer,
    extension: string
  ): Promise<string> {
    const folder = normalizePath(this.settings.attachmentFolder);
    await this.ensureFolder(folder);
    const now = new Date();
    const stamp =
      now.getFullYear().toString() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      "-" +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds());
    const rand = Math.random().toString(36).slice(2, 6);
    const ext = (extension || "png").replace(/^\./, "").toLowerCase();
    const path = `${folder}/mote-${stamp}-${rand}.${ext}`;
    await this.app.vault.createBinary(path, bytes);
    return path;
  }

  /** 递归创建目录（vault.createFolder 只创建一层）。 */
  private async ensureFolder(folder: string): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(folder)) return;
    const slash = folder.lastIndexOf("/");
    if (slash > 0) await this.ensureFolder(folder.slice(0, slash));
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      try {
        await this.app.vault.createFolder(folder);
      } catch {
        // 并发创建时可能已存在，忽略
      }
    }
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
