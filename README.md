# 第二大脑 (Second Brain)

AI 驱动的知识编译引擎 -- 自动将原始笔记编译为结构化 Wiki，维护双向链接和知识索引。

## 它做什么

你把碎片化的原始素材（文章、笔记、会议记录）放进 `raw/` 目录，插件通过 LLM 分析这些素材，自动：

1. 提取核心概念、实体、来源
2. 为每个概念生成结构化的 Wiki 页面（带 YAML frontmatter、双向链接、关联连接）
3. 维护 `index.md` 知识索引
4. 增量编译 -- 只处理变化的文件，跳过未变化的页面

编译完成后，你可以通过内置的对话面板和 Wiki 预览面板浏览和查询知识库。

## 功能

- **增量编译引擎** -- 文件指纹比对 + 内容哈希，只重新生成变化的页面
- **多 LLM 支持** -- DeepSeek、OpenAI、Anthropic Claude、OpenRouter 及任何 OpenAI 兼容 API
- **自动编译** -- 监听 `raw/` 目录变化，防抖触发增量编译
- **Wiki 对话** -- 基于知识库内容的流式 AI 对话，自动检索相关页面作为上下文
- **Wiki 预览** -- 结构化浏览、卡片式索引、搜索、反向链接、面包屑导航
- **单文件编译** -- 命令面板直接编译当前打开的文件

## 安装

### 手动安装

1. 下载最新 release 的 `main.js`、`manifest.json`、`styles.css`
2. 在 Obsidian 库中创建 `.obsidian/plugins/second-brain/` 目录
3. 将三个文件放入该目录
4. 重启 Obsidian，在设置中启用"第二大脑"插件

### 从源码构建

```bash
cd obsidian-second-brain
npm install
npm run build
```

构建产物为 `main.js`，同 `manifest.json` 和 `styles.css` 一起复制到插件目录即可。

## 使用

### 1. 配置

打开插件设置页，填写：

- **LLM Provider** -- 选择你的 AI 服务商
- **Model** -- 模型名称（如 `deepseek-chat`、`gpt-4o`、`claude-sonnet-4-20250514`）
- **API Key** -- 你的 API 密钥，保存在本地不上传
- **Base URL** -- API 端点（已根据 Provider 自动填充，自定义服务可修改）

点击"测试连接"验证配置。

### 2. 准备素材

在 Obsidian 库中创建 `raw/` 目录，放入 Markdown 格式的原始素材。目录结构示例：

```
raw/
  01-articles/
    some-article.md
  05-tweets/
    tweet-thread.md
  06-flash_notes/
    my-thoughts.md
```

### 3. 编译

- 点击左侧栏闪电图标打开编译面板，点击"开始编译"
- 或使用命令面板执行"编译全部素材"
- 或在编辑器中打开某个 raw 文件，执行"编译当前文件"
- 开启"自动编译"后，raw/ 目录有文件变化时会自动触发

### 4. 浏览和对话

- 点击左侧栏地球图标打开 Wiki 预览，浏览知识库索引和页面
- 点击左侧栏对话图标打开 Wiki 对话，向 AI 提问关于知识库的问题
- 对话中的 `[[双链]]` 和引用链接可直接点击跳转到对应页面

## 架构

```
src/
  main.ts              -- 插件入口，注册视图、命令、设置面板
  types.ts             -- 类型定义和默认配置
  core/
    compile.ts         -- 增量编译引擎（分析 -> diff -> 生成 -> 索引）
    llm.ts             -- LLM 适配器（requestUrl + 流式 fetch）
    file-utils.ts      -- Vault 文件操作、指纹比对、相关性搜索
    wiki-schema.ts     -- Prompt 模板和页面规则
  views/
    compile-view.ts    -- 编译面板（右侧栏）
    chat-view.ts       -- Wiki 对话面板（主编辑区）
    wiki-view.ts       -- Wiki 预览面板（主编辑区）
```

编译流程：

```
raw/ 文件 -> 指纹比对 -> 增量/全量 AI 分析 -> 概念/实体/来源提取
-> diff 旧分析 -> 批量生成 Wiki 页面 -> 更新 index.md -> 保存缓存
```

## 目录配置

可在设置中修改：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 素材目录 | `raw` | 存放原始素材的文件夹 |
| Wiki 目录 | `wiki` | AI 编译输出的文件夹 |
| 自动编译 | 开启 | 文件变化时自动触发 |
| 编译延迟 | 30 秒 | 防抖间隔 |

## 注意事项

- 插件标记为 `isDesktopOnly: true`，因为流式对话使用 `fetch` API，移动端不支持
- 编译过程消耗 LLM Token，建议使用 DeepSeek 等低成本服务商
- 首次全量编译后，后续增量编译只处理变化文件，成本可控
- 可在设置中"清理缓存"强制下次全量重编，或"清理 Wiki"删除所有生成内容

## 许可

MIT
