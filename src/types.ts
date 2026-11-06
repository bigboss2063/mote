// ================= 类型定义 =================

/** 单条 memo 记录 */
export interface Memo {
  /** 这条 memo 的文件路径，同时就是它的身份，如 "Mote/2026/2026-04-25 12.43.md" */
  file: string;
  /** 日期 yyyy-MM-dd */
  date: string;
  /** 时间 HH:mm */
  time: string;
  /** 完整 Date 对象（本地时间） */
  datetime: Date;
  /** 正文（文件全文） */
  content: string;
  /** 从正文中解析出来的标签 */
  tags: string[];
  /** 是否包含图片 */
  hasImage: boolean;
  /** 是否包含链接 */
  hasLink: boolean;
  /** 是否置顶（含 #置顶 标签） */
  isPinned: boolean;
  /** 是否收藏（含 #收藏 标签） */
  isStarred: boolean;
  /** v1.5.0: 是否含至少一个未完成任务 `- [ ]`（用于「待办」视图筛选） */
  hasOpenTask: boolean;
  /** v1.5.0: 是否含至少一个已完成任务 `- [x]`（保留字段，未来做"已完成待办"视图用） */
  hasClosedTask: boolean;
}

/** Loose reference used to find a memo card in the Mote feed. */
export interface MemoTarget {
  file: string;
}

export interface MemoriaSettings {
  /** memo 文件存放的目录（相对 vault 根） */
  folder: string;
  /** 图片附件存放的目录（相对 vault 根） */
  attachmentFolder: string;
  /** 快速记录后是否自动清空输入框 */
  clearAfterSave: boolean;
  /** 瀑布流一次加载条数 */
  pageSize: number;
  /** 是否在侧栏显示标签树（关闭后用 Obsidian 自带的标签栏） */
  showSidebarTags: boolean;
  /** v2.3.0: 是否在侧栏显示「年份」分组列表。
   *   笔记跨度长（8 年甚至更多）的用户，右侧年份列表会很长造成视觉干扰，
   *   关闭后可隐藏。默认 true（沿用老行为，不影响现有用户） */
  showSidebarYears: boolean;
  /** v1.1.9: 删除笔记时把文件移到 `_trash/`（关掉就是硬删除） */
  useTrash: boolean;
  /** v1.2.3: 导出图片的背景主题。
   *   "auto" = 跟随 Obsidian 浅/深色
   *   "random" = 每次从预设色板随机一种
   *   预设 id：paper / kraft / mint / peach / sky / lavender / midnight / charcoal
   */
  exportTheme: string;
  /** v1.3.0: 长笔记自动折叠的行数阈值。0 = 永不折叠 */
  collapseLineLimit: number;
  /** v1.4.0: 每日目标笔记数（侧栏进度条的满值）。范围 1-30 */
  dailyGoal: number;
  /** v2.0.0: 视图密度。compact = 紧凑模式，每张卡只显示前几行 */
  density: "cozy" | "compact";
  /** v2.4.0: 桌面端输入区与笔记流的阅读宽度。移动端始终自适应。 */
  contentWidth: "focused" | "balanced" | "wide";
  /** v2.0.0: 启用 Vim 快捷键 */
  enableVimKeys: boolean;
  /** v2.0.0: 启用智能回顾（替代现有的"随机 5 条"为智能挑选） */
  enableSmartReview: boolean;
  /** v2.0.0: UI 语言。"auto" 会跟随 Obsidian 的 moment locale；否则强制指定 */
  language: "auto" | "zh-CN" | "en-US";
  /** v2.0.16: 发送快捷键模式。
   *   "ctrl-enter"  → Ctrl/Cmd+Enter 发送，Enter 换行（默认，对齐 flomo）
   *   "enter"       → Enter 发送，Shift+Enter 换行（适合环境中 Ctrl+Enter 被占用的用户） */
  sendHotkey: "enter" | "ctrl-enter";
  /** v2.0.20: 侧栏顶部默认视图
   *   "heatmap"  → 热力图（默认，沿用老行为）
   *   "calendar" → 月历
   *   "buddy"    → 宠物（v2.1.0 新增）
   *   只影响"第一次打开 Memoria"时显示哪个；用户点切换按钮时的临时切换
   *   只在当前会话生效，不回写此设置（避免"这次我想看月历"被当成"我改默认值"）*/
  defaultOverviewMode: "heatmap" | "calendar" | "buddy";
  /** Obsidian 恢复完工作区后，是否自动打开或切换到 Memoria。 */
  openOnStartup: boolean;
  openLocation: "main" | "left" | "right";
  sidebarCollapsed: boolean;
  /** v2.1.0: 宠物系统
   *   未孵化时 buddy 字段为 null；首次切到宠物视图时引导孵化 */
  buddy: BuddyData | null;
  /** v2.2.0: 移动端输入框入口模式
   *   "fab"            → 默认隐藏输入卡片，右下角浮动 ➕ 按钮（FAB），
   *                      点击 FAB 才展开输入框，对齐 flomo / Memos 移动端体验
   *   "always-visible" → 输入框常驻底部（v2.1.x 及之前的行为）
   *   仅触屏设备生效（hover: none + pointer: coarse），桌面端永远常驻 */
  mobileInputStyle: "fab" | "always-visible";
  /** AI 洞察：默认关闭，用户显式启用并确认隐私说明后才会显示入口。 */
  aiEnabled: boolean;
  /** OpenAI 兼容接口的 Base URL，例如 https://api.openai.com/v1 */
  aiBaseUrl: string;
  /** API Key，保存在插件 data.json 中；本地模型可留空。 */
  aiApiKey: string;
  /** 模型名，例如 gpt-4o-mini / deepseek-chat */
  aiModel: string;
  /** 可选的 embedding 服务：单独一套地址/密钥，因为对话服务（如 DeepSeek）
   *  未必提供 embedding。留空则不建立语义索引，相关笔记只用关键词 + 标签。 */
  aiEmbeddingBaseUrl: string;
  aiEmbeddingApiKey: string;
  /** 可选的 embedding 模型，例如 text-embedding-3-small / nomic-embed-text。 */
  aiEmbeddingModel: string;
  /** 用户已确认：生成时会选中笔记正文发送到上面配置的服务。 */
  aiConsent: boolean;
}

/** v2.1.0: 宠物存档数据（保存在 data.json 里） */
export interface BuddyData {
  species: string;        // SpeciesId（用 string 避免 types.ts 反向依赖 buddy/）
  rarity: string;         // Rarity
  eye: string;
  hat: string;
  shiny: boolean;
  name: string;
  hatchedAt: string;      // ISO 字符串
  seed: number;
}

export const DEFAULT_SETTINGS: MemoriaSettings = {
  folder: "Mote",
  attachmentFolder: "Mote/attachments",
  clearAfterSave: true,
  pageSize: 50,
  showSidebarTags: false,
  showSidebarYears: true,
  useTrash: true,
  exportTheme: "auto",
  collapseLineLimit: 8,
  dailyGoal: 5,
  density: "cozy",
  contentWidth: "balanced",
  enableVimKeys: false,
  enableSmartReview: true,
  language: "auto",
  sendHotkey: "ctrl-enter",
  defaultOverviewMode: "heatmap",
  openOnStartup: false,
  openLocation: "main",
  sidebarCollapsed: false,
  buddy: null,
  mobileInputStyle: "fab",
  aiEnabled: false,
  aiBaseUrl: "",
  aiApiKey: "",
  aiModel: "",
  aiEmbeddingBaseUrl: "",
  aiEmbeddingApiKey: "",
  aiEmbeddingModel: "",
  aiConsent: false,
};

export const VIEW_TYPE_MEMORIA = "memoria-view";
export const VIEW_TYPE_MEMORIA_STATS = "memoria-stats-view";
export const VIEW_TYPE_MEMORIA_YEAR = "memoria-year-view";

/** 保留标签：这些标签不会在侧栏的标签列表里显示，也不会出现在卡片底部胶囊 */
export const PIN_TAG = "置顶";
export const STAR_TAG = "收藏";
export const RESERVED_TAGS = new Set([PIN_TAG, STAR_TAG]);
