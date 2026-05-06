# Second Brain

An AI-powered knowledge compiler for Obsidian. Drop in scattered notes, get back a structured wiki with bidirectional links, semantic search, and an AI chat that cites your own knowledge.

## How It Works

```
raw/ (your notes)  -->  AI Compile  -->  wiki/ (knowledge base)
   articles               LLM extracts          concepts with [[links]]
   highlights             concepts,             entity pages
   highlights             entities,             source summaries
   highlights             sources               index + mind map
```

1. **Put notes** in `raw/` — ideally material your mind has already worked through (see **Raw folder guide** below)
2. **Compile** — AI extracts concepts, entities, and sources, writes structured wiki pages
3. **Browse & Chat** — explore your knowledge base or ask questions with cited answers

Incremental compilation: only changed files are re-processed. Subsequent compiles finish in seconds.

## Raw folder guide

**What to put in `raw/`:** notes that are already *yours* in a cognitive sense—**handwritten or self-authored notes** (ideas, paraphrases, reflections), and **web clippings only after you have read and absorbed them** (e.g. with your own highlights or a line on why the piece matters). `raw/` is not meant to be an endless “read later” graveyard.

**What “already worked through” means:** it does **not** mean “memorized word for word.” It means you have already paid attention—read (or skimmed with intent), thought about it, and **connected it to what you already know or do**—so the file is no longer a stranger on disk. Typical signals: you wrote it yourself; or you read someone else’s piece **at least once** and left a personal trace (highlight, margin note, a one-line takeaway, or “how this relates to project X”). The opposite—saved links you never opened, full clips never read, “might be useful someday” with no concrete use—usually still counts as **unprocessed**; keep those in read-later or an inbox, and **promote into `raw/`** after they become real input. In one line: information becomes **knowledge you helped construct**, not just something you filed.

**The principle:** keep the **source layer close to what your brain already holds**. The compiler turns `raw/` into a linked wiki—a *second brain* for knowledge you are ready to connect and reuse. If `raw/` is mostly unread captures, the wiki can still look busy, but it drifts away from *externalized understanding* toward *automated hoarding*—and the whole product goal—**building a second brain**—starts to skew off course.

**Practical habit:** park unread links and full-text dumps outside this pipeline (or in a separate inbox). **Promote into `raw/`** once a piece has become real mental input—then compile, so the wiki tracks what you actually think with, not what you merely saved.

## Quick Start

### Install from Obsidian Community Plugins (Recommended)

1. Open Obsidian Settings → Community Plugins → Browse
2. Search for "Second Brain"
3. Click Install, then Enable

### Alternative: Manual Install

Download **`second-brain.zip`** from **[GitHub Releases](https://github.com/graceruowenwang/second-brain-release/releases)** or **[Gitee Releases](https://gitee.com/grinningGrace/second-brain-release/releases)**, unzip and open as an Obsidian Vault.

### Configure API Key

1. Get an API key from [DeepSeek](https://platform.deepseek.com) (recommended, ~$0.002/1K tokens)
2. Open plugin settings, enter Provider / Model / API Key
3. Click "Test Connection"

Your API key stays local. Nothing is uploaded.

### Compile

- Click the lightning icon in the left sidebar, then "Start Compile"
- Or use the command palette: `Cmd/Ctrl+Shift+C`
- The first compile processes all files; subsequent runs are incremental

### Browse Your Wiki

- **Wiki Preview** (globe icon) — card index, page viewer, SVG mind map, search
- **Wiki Chat** (chat icon) — ask questions about your knowledge base, answers cite `[[wiki-links]]`

## Features

### Free

| Feature | Description |
|---------|-------------|
| Manual Compile | Compile all or individual files on demand |
| Wiki Browser | Card-based index, page preview, backlinks |
| Global Search | Search concepts, entities, sources |
| Multi-LLM | DeepSeek, OpenAI, Claude, OpenRouter, any OpenAI-compatible API |
| Multi-language UI | English, Chinese, Japanese |
| Custom Templates | Editable prompt templates for compilation |
| Vector Search | Embedding-based semantic search with keyword fallback |
| Vault Scanner | Auto-detect and import existing notes as raw materials |
| Knowledge Health | Freshness tracking, stale page alerts, orphan detection |

### Pro

| Feature | Description |
|---------|-------------|
| Auto Compile | Watch `raw/` for changes, compile automatically with debounce |
| AI Chat | Streaming conversation with your knowledge base |
| SVG Mind Map | Interactive visual knowledge graph |
| Multi-LLM Backend | Switch between providers in one click |

**Pricing**: $5 one-time purchase (via Gumroad). First successful compile starts a **14-day full Pro trial**.

## Disclosures

- **Paid features**: Pro tier ($5 one-time) unlocks auto-compile, AI chat, SVG mind map, and multi-LLM backend. Free features are fully usable without payment. First compile starts a 14-day full Pro trial.
- **Network usage**: This plugin connects to external LLM APIs (e.g., DeepSeek, OpenAI, Claude) for compilation and chat. API calls are made directly from your device — your notes and API key are never sent to any server other than the LLM provider you configure.
- **API key required**: You need your own API key from a supported LLM provider. Costs depend on your provider and usage (see Cost Estimate below).

## Folder Structure

```
raw/                        # Your input (immutable)
  01-articles/              # Web clippings, articles
  02-books/                 # Book notes
  03-podcasts/              # Podcast notes
  04-videos/                # Video notes
  05-tweets/                # Tweet threads
  06-flash_notes/           # Flash notes, ideas
    inbox/                  # Staging area (auto-sorted on compile)

wiki/                       # AI-generated output
  concepts/核心概念/         # Core concepts
  concepts/方法框架/         # Methods & frameworks
  concepts/实践经验/         # Practice & experience
  entities/                 # People, companies, tools
  sources/                  # Source summaries
  syntheses/                # Cross-concept analysis
  index.md                  # Auto-generated wiki index
  log.md                    # Compile log + weekly reports
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| LLM Provider | DeepSeek | AI backend |
| Model | deepseek-chat | Model name |
| Raw Folder | `raw` | Input materials folder |
| Wiki Folder | `wiki` | Output wiki folder |
| Auto Compile | On | Trigger on file changes (Pro) |
| Compile Delay | 30s | Debounce interval |
| Embedding Model | text-embedding-3-small | Semantic search model |
| Language | Auto | Follows Obsidian setting |

## Cost Estimate

| Item | Cost |
|------|------|
| Plugin | Free, open source |
| Obsidian | Free |
| DeepSeek API (recommended) | ~$0.15/1M input tokens, ~$0.20/1M output tokens |
| Other LLMs | Pay-per-token; incremental compile keeps costs low |

First full compile uses the most tokens. Incremental compiles only process changed files. Typical usage (dozens of notes/month + occasional chat): a $2 DeepSeek balance lasts months.

## Notes

- Desktop only (`isDesktopOnly: true`) — streaming chat requires `fetch` API
- Wiki cleanup requires typing CONFIRM to prevent accidental deletion

## License

MIT

---

## 中文说明

碎片化笔记太多，找不到、连不上、用不起来？Second Brain 是一个 AI 驱动的知识编译器。把散乱的笔记丢进去，它会自动提取概念、实体和知识来源，生成带双向链接、分类索引和语义搜索的结构化 Wiki 知识库。

### 工作原理

```
raw/ (你的素材)  -->  AI 编译  -->  wiki/ (知识库)
  文章剪藏              LLM 提取          带 [[双链]] 的概念页
  读书笔记              概念、实体、       实体页面
  播客笔记              知识来源           素材摘要
  闪念笔记                                索引 + 知识图谱
```

1. **放入素材** -- 把笔记放到 `raw/` 目录下；**建议以「大脑已经处理过」的内容为主**（见下方「素材目录使用指南」）
2. **AI 编译** -- LLM 自动提取概念、实体和来源，生成结构化的 Wiki 页面
3. **浏览与对话** -- 浏览知识库，或用 AI 对话功能提问，回答自动引用你的 `[[wiki-links]]`

支持增量编译：只处理有变化的文件，后续编译几秒完成。

### 素材目录（raw）使用指南

**建议放进 `raw/` 的：**你自己**手写或亲手整理**的笔记（想法、转述、复盘），以及**已经读过、消化过**的网页剪藏（最好带自己的高亮或一两句「这对我意味着什么」）。`raw/` 不适合当成无限膨胀的「稍后读」堆场。

**什么叫「大脑已经处理过」？** 这里**不是**指「能背下来、能默写」，而是指你已经用**注意力**读过、想过，并**和自己的经验或任务对上过号**——材料不再只是磁盘上的陌生字节。常见情况包括：你自己写下来的内容；或外部文章/视频稿等你**至少认真读过一遍**，并留下至少一种「个人痕迹」（高亮、批注、用自己的话写两句总结、标明「和我正在做的 X 有什么关系」）。反过来：收藏从未打开、全文剪藏一眼没看、也说不出具体使用场景，多半仍算**未处理**——更适合先放在稍后读或单独收件箱，**升格进 `raw/`** 应在它真的变成你的输入之后。**一句话：**从「别人的信息」变成「你参与过意义建构的信息」。

**核心原则：**让 **raw 这一层尽量贴近「大脑已经掌握、正在使用的知识」**。插件会把 `raw/` 编译成带链接的 Wiki，扮演的是**第二大脑**——用来串联和复用你已经理解的东西。若 `raw/` 里多半是未读收藏，输出再漂亮也容易变成**囤积自动化**，整体目标会从「**外显化的理解**」悄悄偏成「**存了很多但脑里没接上**」，**建立第二大脑**这件事就容易跑偏。

**习惯上可以这样分：**未读链接、整篇丢进去但还没看的材料，先放在别处或单独收件箱；**只有当你真的读进去、变成自己的输入之后，再升格进 `raw/`** 再编译，这样 Wiki 跟踪的是你**在思考时用得上的知识**，而不只是你点过保存的文件。

### 快速开始

#### 从社区插件市场安装（推荐）

1. 打开 Obsidian 设置 → 第三方插件 → 浏览
2. 搜索 "Second Brain"
3. 点击安装，然后启用

#### 手动安装

从 **[GitHub Releases](https://github.com/graceruowenwang/second-brain-release/releases)** 或 **[Gitee 发行版](https://gitee.com/grinningGrace/second-brain-release/releases)** 下载 `second-brain.zip`，解压后作为 Obsidian Vault 打开。

#### 配置 API Key

1. 在 [DeepSeek 开放平台](https://platform.deepseek.com) 注册并获取 API Key（推荐，约 0.002 元/千 token）
2. 打开插件设置，填写 Provider / Model / API Key
3. 点击「测试连接」确认可用

API Key 仅保存在本地，不会上传到任何服务器。

#### 编译

- 点击左侧栏的闪电图标，然后点击「开始编译」
- 或使用命令面板快捷键：`Cmd/Ctrl+Shift+C`
- 首次编译会处理所有文件，后续编译自动增量处理

#### 浏览知识库

- **Wiki 浏览器**（地球图标）-- 卡片索引、页面阅读器、SVG 知识图谱、搜索
- **Wiki 对话**（对话图标）-- 针对你的知识库提问，回答自动引用 `[[wiki-links]]`

### 功能一览

#### 免费功能

| 功能 | 说明 |
|------|------|
| 手动编译 | 按需编译全部或单个文件 |
| Wiki 浏览器 | 卡片式索引、页面预览、反向链接 |
| 全局搜索 | 搜索概念、实体、素材 |
| 多 LLM 支持 | DeepSeek、OpenAI、Claude、OpenRouter 及任何 OpenAI 兼容 API |
| 多语言界面 | 中文、英文、日文 |
| 自定义模板 | 可编辑的编译提示词模板 |
| 向量搜索 | 基于 Embedding 的语义搜索，带关键词回退 |
| 笔记库扫描 | 自动检测并导入已有笔记作为素材 |
| 知识健康度 | 新鲜度追踪、过期页面提醒、孤儿页面检测 |

#### Pro 功能

| 功能 | 说明 |
|------|------|
| 自动编译 | 监听 `raw/` 目录变化，自动编译（带防抖） |
| AI 对话 | 与知识库的流式对话 |
| SVG 知识图谱 | 可交互的可视化知识网络 |
| 多 LLM 后端 | 一键切换 AI 提供商 |

**定价**：$5 买断（通过 Gumroad）。首次编译成功后开启 **14 天完整 Pro 试用**。

### 披露声明

- **付费功能**：Pro 版（$5 买断）解锁自动编译、AI 对话、SVG 知识图谱和多 LLM 后端。免费功能无需付费即可完整使用。首次编译开启 14 天完整 Pro 试用。
- **网络使用**：本插件需要连接外部 LLM API（如 DeepSeek、OpenAI、Claude）进行编译和对话。API 请求直接从你的设备发出，笔记和 API Key 不会发送到除你选择的 LLM 提供商之外的任何服务器。
- **需要 API Key**：你需要自行获取支持的 LLM 提供商的 API Key。费用取决于你的提供商和用量（见下方费用说明）。

### 目录结构

```
raw/                        # 你的输入素材（不可变）
  01-articles/              # 网页剪藏、文章
  02-books/                 # 读书笔记
  03-podcasts/              # 播客笔记
  04-videos/                # 视频笔记
  05-tweets/                # 推文串
  06-flash_notes/           # 闪念笔记、想法
    inbox/                  # 暂存区（编译时自动归类）

wiki/                       # AI 生成的知识库
  concepts/核心概念/         # 核心概念 -- 领域中最基础的观点和立场
  concepts/方法框架/         # 方法框架 -- 用来分析和解决问题的结构化工具
  concepts/实践经验/         # 实践经验 -- 来自真实场景的案例和反思
  entities/                 # 人物、公司、工具、产品
  sources/                  # 素材摘要
  syntheses/                # 跨概念综合分析
  index.md                  # 自动生成的 Wiki 索引
  log.md                    # 编译日志 + 周报
```

### 设置项

| 设置 | 默认值 | 说明 |
|------|--------|------|
| LLM 提供商 | DeepSeek | AI 后端服务 |
| 模型 | deepseek-chat | 模型名称 |
| 素材目录 | `raw` | 输入素材文件夹 |
| Wiki 目录 | `wiki` | 输出知识库文件夹 |
| 自动编译 | 开启 | 文件变化时触发（Pro 功能） |
| 编译延迟 | 30 秒 | 防抖间隔 |
| Embedding 模型 | text-embedding-3-small | 语义搜索模型 |
| 界面语言 | 自动 | 跟随 Obsidian 设置 |

### 费用说明

| 项目 | 费用 |
|------|------|
| 插件本身 | 免费开源 |
| Obsidian | 免费 |
| DeepSeek API（推荐） | 输入约 1 元/百万 token，输出约 1.4 元/百万 token |
| 其他 LLM | 按量计费；增量编译可将成本控制在很低水平 |

首次全量编译消耗 token 最多，后续增量编译只处理变化文件。日常使用（每月几十条笔记 + 偶尔对话），DeepSeek 充值 10 元可用几个月。

### 其他说明

- 仅支持桌面端（`isDesktopOnly: true`）-- 流式对话依赖 `fetch` API
- 清理 Wiki 需要输入 CONFIRM 确认，防止误删
- 开发者文档（从源码构建、GitHub + Gitee 双托管）请参见 [CONTRIBUTING.md](CONTRIBUTING.md)

### 许可证

MIT
