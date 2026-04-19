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

### Install

1. Download `second-brain.zip` from [Releases](https://github.com/graceruowenwang/obsidian-second-brain/releases)
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

**Pricing**: $3.99/month or $29.99/year. First compile triggers a 3-day Pro trial.

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
npm install
npm run release
```

Produces `second-brain.zip` containing `main.js`, `manifest.json`, `styles.css`. Extract into `.obsidian/plugins/second-brain/`.

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

碎片化笔记太多，找不到、连不上、用不起来？Second Brain 帮你把它们编译成结构化的 Wiki 知识库。放进去的是散乱素材，得到的是带双向链接和分类索引的知识网络。

### 快速开始

1. 从 [Releases](https://github.com/graceruowenwang/obsidian-second-brain/releases) 下载 `second-brain.zip`，解压后用 Obsidian 打开
2. 在 [platform.deepseek.com](https://platform.deepseek.com) 申请 API Key，填入插件设置
3. 把笔记放入 `raw/` 目录（每个子目录有 `_usage.md` 说明）
4. 点击闪电图标开始编译

### 费用

- 插件免费开源
- DeepSeek API 充值 10 元可用几个月（增量编译只处理变化文件）
- Pro 功能：$3.99/月 或 $29.99/年，首次编译自动开启 3 天试用

### 从源码构建

```bash
npm install
npm run release
```
