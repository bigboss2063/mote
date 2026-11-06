# Mote 🪶

Obsidian 里的随手记：一个输入框，记完就走。数据是自己的纯 Markdown。

在 [Memoria](https://github.com/i-iooi-i/obsidian-memoria) 的基础上继续维护。0.1.0 起存储格式重写：**一条 memo 一个文件**，引用就是普通的 wikilink。

![主视图](./docs/screenshots/main.png)

## 存储格式

```text
Mote/
├── 2026/
│   ├── 2026-04-25 12.43.md
│   └── 2026-04-25 14.20.md
└── _insights/
    └── 2026-04-25 15.47 今天的想法.md
```

`2026-04-25 12.43.md` 的全文就是这条 memo：

```markdown
想到就记，记完就忘。
#灵感
```

文件名就是时间，没有 frontmatter，没有缩进，同一分钟的第二条自动叫 `12.43.01.md`。引用一条 memo：

```markdown
> [!quote] [[2026-04-25 12.43]]
```

改时间 = 在 Obsidian 里重命名，全库链接自动跟着改。停用插件、换掉 Obsidian，文件依然是能读能 grep 的 md。

AI 洞察也落成笔记：`_insights/` 下一文一文件，来源写在 frontmatter 的 `sources` 里；正文的 `[1]` 保持纯文本，渲染时按 `sources` 顺序映射成可点的引用。

## 能做什么

- 速记：输入卡片、`Ctrl/Cmd+Enter` 发送、全局快捷键、iOS 快捷指令
- 瀑布流、按天分组、置顶/收藏、组合搜索
- 侧栏热力图、月历、数据报告、年度全景
- 图片粘贴/拖拽入库；任务勾选回写；删除移到 `_trash/`
- AI 洞察（可选，走自己的 OpenAI 兼容接口）：对单条或当前筛选生成带引用的洞察

## 安装

手动放置三件套到 `<vault>/.obsidian/plugins/mote/`，或用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 添加 `bigboss2063/mote`。

0.1.0 不读取 2.x 的 `YYYY.md`；旧数据用仓库里的 `scripts/migrate.mjs` 一次性迁移（默认 dry-run，加 `--apply` 写盘）。

## 开发

```bash
npm install
npm run dev        # watch
npm test           # node --test
npm run typecheck
npm run build
```

## 许可

MIT，fork 自 Memoria；`LICENSE` 保留原作者版权。变更记录见 [CHANGELOG.md](./CHANGELOG.md)。
