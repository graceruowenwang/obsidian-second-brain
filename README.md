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

1. **Put notes** in `raw/` (articles, highlights, flash notes, anything)
2. **Compile** — AI extracts concepts, entities, and sources, writes structured wiki pages
3. **Browse & Chat** — explore your knowledge base or ask questions with cited answers

Incremental compilation: only changed files are re-processed. Subsequent compiles finish in seconds.

## Quick Start

Installable **`second-brain.zip`** and demo assets are published from **[second-brain-release](https://github.com/graceruowenwang/second-brain-release)** on GitHub Releases, with a **[Gitee mirror](https://gitee.com/grinningGrace/second-brain-release/releases)** for faster access in China. This repo (**obsidian-second-brain**) holds plugin source code, CI, and development.

### Install

1. Download `second-brain.zip` from **[GitHub Releases](https://github.com/graceruowenwang/second-brain-release/releases)** or **[Gitee Releases](https://gitee.com/grinningGrace/second-brain-release/releases)**
2. Unzip and open the folder as an Obsidian Vault

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

**Pricing**: ¥30 one-time purchase. First compile triggers a 3-day Pro trial.

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

## Build from Source

```bash
npm ci --legacy-peer-deps
# or: npm install --legacy-peer-deps
npm run release
```

Produces `second-brain.zip` containing `main.js`, `manifest.json`, `styles.css`. Extract into `.obsidian/plugins/second-brain/`.

Before cutting a release build for **second-brain-release**, run **`npm run ci`** locally in this repo (typecheck + tests + production build), then `npm run release` and attach the zip to **second-brain-release** on GitHub. Pushes and PRs to `main` / `master` here run CI; successful runs attach `main.js`, `manifest.json`, and `styles.css` as a workflow artifact for sanity checks.

### GitHub + Gitee (dual remotes)

- **Gitee Go (runs on Gitee):** enable **Gitee Go** for the Gitee repo and point it at **`.workflow/branch-pipeline.yml`**. That pipeline runs the same checks as GitHub CI (`npm ci --legacy-peer-deps`, `typecheck`, `test`, `build`). If `nodeVersion: 18.20.4` is not available in your Gitee tenant, change it in the Gitee UI or edit the YAML to a supported version.
- **Releases on Gitee:** [grinningGrace/second-brain-release → Releases](https://gitee.com/grinningGrace/second-brain-release/releases) hosts the same install zip as GitHub for users in China.
- **Mirror from GitHub (optional):** workflow **`.github/workflows/sync-gitee.yml`** runs after a **successful CI** run triggered by **`push`** to `main` or `master`, or when you run it manually (**Actions → Sync to Gitee → Run workflow**). Configure secrets `GITEE_REPO`, `GITEE_TOKEN`, and `GITEE_USERNAME` on GitHub. The job force-pushes the same branch name to Gitee (`main`→`main`, `master`→`master`); keep default branch names aligned on both hosts or adjust the workflow. If secrets are missing, the job skips the push and still succeeds.

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

1. **放入素材** -- 把笔记放到 `raw/` 目录下（文章、高亮、闪念笔记，什么都行）
2. **AI 编译** -- LLM 自动提取概念、实体和来源，生成结构化的 Wiki 页面
3. **浏览与对话** -- 浏览知识库，或用 AI 对话功能提问，回答自动引用你的 `[[wiki-links]]`

支持增量编译：只处理有变化的文件，后续编译几秒完成。

### 快速开始

安装包 **`second-brain.zip`** 与演示素材发布在 **[second-brain-release](https://github.com/graceruowenwang/second-brain-release)** 的 GitHub Releases；国内可优先从 **[Gitee 发行版](https://gitee.com/grinningGrace/second-brain-release/releases)** 下载。本仓库 **obsidian-second-brain** 为插件源码与 CI。

#### 安装

1. 从 **[GitHub Releases](https://github.com/graceruowenwang/second-brain-release/releases)** 或 **[Gitee Releases](https://gitee.com/grinningGrace/second-brain-release/releases)** 下载 `second-brain.zip`
2. 解压后，将文件夹作为 Obsidian Vault 打开

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

**定价**：¥30 买断。首次编译自动开启 3 天 Pro 试用。

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

### 从源码构建

```bash
npm ci --legacy-peer-deps
# 或 npm install --legacy-peer-deps
npm run release
```

生成 `second-brain.zip`，包含 `main.js`、`manifest.json`、`styles.css`。解压到 `.obsidian/plugins/second-brain/` 即可。

**发版前建议**：在本仓库执行 `npm run ci`，再 `npm run release` 生成 zip，将产物上传到 **second-brain-release** 的 Releases。推送到 `main` / `master` 或提 PR 时，本仓库 GitHub Actions 会跑同一套检查；通过后可从 workflow 产物中下载三件套核对体积与内容。

### GitHub 与 Gitee 双托管

- **在 Gitee 上跑 CI**：仓库启用 **Gitee Go**，关联仓库根目录 **`.workflow/branch-pipeline.yml`**（与 GitHub 的 `typecheck` + `test` + `build` 一致）。若流水线提示 Node `18.20.4` 不可用，在 Gitee 可视化配置里改成平台支持的版本，或修改 YAML 中的 `nodeVersion`。
- **国内下载发行包**：[Gitee — second-brain-release / 发行版](https://gitee.com/grinningGrace/second-brain-release/releases)（与 GitHub Releases 内容对应，按需同步）。
- **从 GitHub 同步到 Gitee（可选）**：配置 GitHub Secrets：`GITEE_REPO`（如 `用户名/仓库名`）、`GITEE_TOKEN`（有 push 权限的私人令牌）、`GITEE_USERNAME`。**CI** 在 **`push` 到 `main`/`master` 且成功** 后会触发 **Sync to Gitee**；也可在 Actions 里手动运行。未配置 secret 时只跳过推送、不报错。同步使用 `--force`，请确认 Gitee 侧无仅存在于本地的提交，或接受以 GitHub 为准覆盖。

### 许可证

MIT
