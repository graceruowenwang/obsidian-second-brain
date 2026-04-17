# Second Brain -- Obsidian 知识编译插件

碎片化笔记太多，找不到、连不上、用不起来？

这个插件帮你把它们编译成结构化的 Wiki 知识库。放进去的是散乱素材，得到的是带双向链接和分类索引的知识网络。

## 费用

| 项目 | 费用 |
|------|------|
| 插件本身 | 免费、开源 |
| Obsidian | 免费 |
| DeepSeek API | 每月 5 亿 token 免费额度，个人使用基本用不完 |
| 其他 LLM（可选） | 按 token 计费，插件的增量编译只处理变化文件，成本很低 |

推荐使用 DeepSeek（deepseek-chat），注册即送每月免费额度，覆盖日常编译和对话完全够用。

## 快速开始

### 第一步：安装插件

下载 release 中的 `main.js`、`manifest.json`、`styles.css`，放入 Vault 的 `.obsidian/plugins/second-brain/` 目录，重启 Obsidian 并启用插件。

### 第二步：申请 API Key

1. 访问 [platform.deepseek.com](https://platform.deepseek.com)，注册并创建 API Key
2. 在插件设置页填入 Provider（DeepSeek）、Model（deepseek-chat）和 API Key
3. 点击「测试连接」，看到成功提示即可

API Key 保存在本地，不会上传到任何服务器。

### 第三步：放入素材

在 Vault 根目录创建 `raw/` 文件夹，把你的笔记放进去：

```
raw/
  01-articles/      # 网页剪藏、文章
  02-books/         # 读书笔记、书评
  03-podcasts/      # 播客笔记
  04-videos/        # 视频笔记
  05-tweets/        # 推文线程
  06-flash_notes/   # 闪念笔记、灵感
    inbox/          # 暂存区（编译时自动整理）
```

仓库中提供了 `raw-sample/` 样例目录，每个文件夹都有 `_usage.md` 说明该放什么，可以直接复制使用：

```bash
# 下载样例目录到你的 Vault
svn export https://gitee.com/grinningGrace/obsidian-second-brain/raw-sample /你的Vault路径/raw
```

### 第四步：编译

- 点击左侧栏闪电图标，按「开始编译」
- 或使用命令面板（Cmd/Ctrl+P）搜索「编译全部素材」
- 也可以打开某个 raw 文件，执行「编译当前文件」
- 开启「自动编译」后，素材有变化时自动触发

首次编译耗时取决于素材量，后续增量编译只处理变化的文件，几秒就能完成。

### 第五步：浏览和对话

编译完成后：

- **Wiki 预览**（地球图标）-- 卡片式索引、页面浏览、SVG 思维导图、全局搜索
- **Wiki 对话**（对话图标）-- 向 AI 提问关于知识库的问题，回答会引用 `[[双链]]` 指向具体页面

## 功能一览

**编译**
- 增量编译 -- 文件指纹比对（mtime / size / MD5），只处理变化的文件
- 自动编译 -- 监听 raw/ 变化，防抖触发（默认 30 秒）
- 单文件编译 -- 命令面板直接编译当前文件

**浏览**
- Wiki 预览 -- 卡片式索引、页面浏览（反向链接、面包屑导航）
- SVG 思维导图 -- 可视化知识网络
- 全局搜索

**对话**
- 基于知识库的流式 AI 对话
- 语义向量检索相关页面
- 对话中的 `[[双链]]` 和引用链接可直接点击跳转

**知识管理**
- Draft / Review 工作流 -- 新页面标注 draft，审核后标记 reviewed
- 健康检查 -- 自动修复死链、补全关联连接、报告孤岛页面

**兼容性**
- 多 LLM 后端 -- DeepSeek、OpenAI、Anthropic Claude、OpenRouter 及任何 OpenAI 兼容 API
- 多语言界面 -- 中文、英文、日文，跟随 Obsidian 设置

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

## 从源码构建

```bash
npm install
npm run build
```

产物为 `main.js`，和 `manifest.json`、`styles.css` 一起复制到插件目录。

## 注意事项

- 仅桌面端（`isDesktopOnly: true`），流式对话依赖 `fetch` API
- 清理 Wiki 需输入 CONFIRM 确认，防止误操作

## 许可

MIT
