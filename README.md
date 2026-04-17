# Second Brain -- Obsidian 知识编译插件

AI 驱动的知识编译引擎，运行在 Obsidian 内部。

把 Vault 中 `raw/` 目录下的碎片化笔记喂给 LLM，自动编译成结构化的 Wiki 知识库 -- 双向链接、YAML frontmatter、分类索引，开箱即用。

## 它解决什么问题

你在 Obsidian 里积累了大量笔记，但它们是碎片化的、没有结构的。这个插件做的事：

1. 读取你的原始素材（文章、推文、闪念笔记）
2. 通过 LLM 提取概念、实体、来源
3. 自动生成带双向链接和分类索引的 Wiki 页面
4. 增量编译 -- 只处理变化的文件

## 核心能力

- **增量编译** -- 文件指纹比对（mtime / size / MD5），只处理变化的文件
- **多 LLM 后端** -- DeepSeek、OpenAI、Anthropic Claude、OpenRouter，以及任何 OpenAI 兼容 API
- **自动编译** -- 监听 `raw/` 变化，防抖触发（默认 30 秒）
- **Wiki 预览** -- 卡片式索引、页面浏览（反向链接、面包屑）、SVG 思维导图、全局搜索
- **Wiki 对话** -- 基于知识库的流式 AI 对话，语义向量检索相关页面，`[[双链]]` 可点击跳转
- **单文件编译** -- 命令面板直接编译当前文件
- **Draft / Review 工作流** -- 新页面标注 draft，审核后标记 reviewed
- **健康检查** -- 自动修复死链、补全关联连接、报告孤岛页面
- **多语言界面** -- 中文、英文、日文，跟随 Obsidian 设置

## 安装

### Obsidian 社区插件市场

（尚未上架，敬请期待）

### 手动安装

1. 下载 release 中的 `main.js`、`manifest.json`、`styles.css`
2. 在 Vault 中创建 `.obsidian/plugins/second-brain/`
3. 把三个文件放进去
4. 重启 Obsidian，启用插件

### 从源码构建

```bash
npm install
npm run build
```

产物为 `main.js`，和 `manifest.json`、`styles.css` 一起复制到插件目录。

## 使用

### 1. 配置

在插件设置页填写 LLM 服务商、模型名、API Key 和 Base URL。点击「测试连接」验证。API Key 保存在本地。

### 2. 准备素材

在 Vault 根目录创建 `raw/`，按类型分文件夹放入 Markdown 素材。仓库中提供了 `raw-sample/` 样例目录，包含完整的目录结构和每个文件夹的 `_usage.md` 说明：

```bash
# 从仓库下载 raw-sample（二选一）

# 方式一：下载整个仓库后复制
git clone https://gitee.com/grinningGrace/obsidian-second-brain.git
cp -r obsidian-second-brain/raw-sample/  /你的Vault路径/raw/

# 方式二：只下载 raw-sample 目录（需要 svn）
svn export https://gitee.com/grinningGrace/obsidian-second-brain/raw-sample /你的Vault路径/raw
```

目录结构：

```
raw/
  01-articles/      # 网页剪藏、文章
  02-books/         # 读书笔记、书评
  03-podcasts/      # 播客笔记、访谈摘要
  04-videos/        # 视频笔记、演讲整理
  05-tweets/        # 推文线程、社交媒体长文
  06-flash_notes/   # 闪念笔记、原创思考
    inbox/          # 暂存区（编译时自动整理）
```

每个目录下都有 `_usage.md` 说明该放什么、怎么命名。把你的素材放到大致合适的目录即可，不要求分类精确。

### 3. 编译

- 左侧栏闪电图标 -> 「开始编译」
- 命令面板 -> 「编译全部素材」
- 编辑器中打开 raw 文件 -> 「编译当前文件」
- 开启「自动编译」后，文件变化时自动触发

### 4. 浏览与对话

- 地球图标：Wiki 预览（索引 / 页面 / 思维导图）
- 对话图标：基于知识库的 AI 对话，回答带 `[[双链]]` 引用

## 架构

```
src/
  main.ts             -- 插件入口
  types.ts            -- 类型定义
  core/
    compile.ts        -- 增量编译引擎
    llm.ts            -- LLM 适配器（requestUrl + 流式 fetch）
    file-utils.ts     -- 文件操作、指纹比对、语义搜索
    wiki-schema.ts    -- Prompt 模板
    templates.ts      -- 模板配置
    i18n.ts           -- 国际化
  views/
    compile-view.ts   -- 编译面板
    chat-view.ts      -- Wiki 对话面板
    wiki-view.ts      -- Wiki 预览面板（含思维导图）
```

编译流程：

```
raw/ -> 指纹比对 -> AI 分析 -> 概念/实体/来源提取
-> diff 旧数据 -> 批量生成 Wiki 页面 -> 更新 index.md
```

## 设置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| LLM Provider | DeepSeek | AI 服务商 |
| Model | deepseek-chat | 模型名称 |
| 素材目录 | `raw` | 原始素材文件夹 |
| Wiki 目录 | `wiki` | 编译输出文件夹 |
| 自动编译 | 开启 | 文件变化时自动触发 |
| 编译延迟 | 30 秒 | 防抖间隔 |
| Embedding 模型 | text-embedding-3-small | 语义检索向量模型 |
| 界面语言 | Auto | 跟随 Obsidian |

## 限制

- 仅桌面端（`isDesktopOnly: true`），流式对话依赖 `fetch` API
- 清理 Wiki 需输入 CONFIRM 确认

## 许可

MIT
