---
title: "VibeCoding (Vibe Coding)"
type: concept
level: 实践经验
status: "draft"
tags: [AI辅助编程, 软件开发实践, 编程方法论]
last_updated: 2026-05-16
---

**Vibe Coding** 是一种由 AI 辅助的软件开发实践，程序员通过自然语言提示（prompt）向大语言模型描述任务，AI 自动生成源代码，而开发者可能不彻底审查输出，而是依赖结果和后续提示来引导修改。

该术语由 [[AiAssistedCoding|AI 辅助编程]] 领域的先驱 Andrej Karpathy 于 2025 年 2 月创造，Collins 英语词典将其评为 2025 年度词汇。它代表了 AI 时代编程范式从"手写代码"向"对话式编程"的激进转变，但也引发了关于代码质量、安全性和开发者能力的广泛争议。

## 起源与定义

Vibe Coding 的核心特征是"沉浸于感觉，拥抱指数级增长，甚至忘记代码的存在"。Karpathy 在原始描述中强调，他几乎不碰键盘，只是与 AI 对话，要求"把侧边栏的 padding 减半"这样的任务，并始终点击"全部接受"，不再查看代码差异（diffs）。当遇到错误时，直接复制粘贴错误信息给 AI，通常就能修复。最终，代码增长到他无法理解的程度。

[[RetrievalAugmentedGeneration|检索增强生成 (RAG)]] 等技术为这种实践提供了底层支持，但 Vibe Coding 更强调对 AI 输出的信任和依赖，而非对代码的深入理解。[[SpecDrivenDevelopment|规格驱动开发]] 则代表了与之相反的结构化路径。

> [原创] 关键区分在于：Vibe Coding 不是简单的 AI 辅助编程，而是将编程的主体性从人类转移到了 AI。开发者从"编码者"变成了"需求描述者"和"结果验收者"。

## 优点与争议

### 优点

- **降低编程门槛**：非专业程序员也能创建可用的软件。纽约时报记者 Kevin Roose 在 2025 年 2 月使用 Vibe Coding 创建了多个小型应用，将其描述为"为一人定制的软件"
- **快速原型**：适合一次性项目、周末项目和 MVP 开发。Y Combinator 2025 年冬季批次中 25% 的创业公司代码库 95% 由 AI 生成
- **专业应用**：2025 年 7 月华尔街日报报道，专业软件工程师也开始将 Vibe Coding 用于商业场景。Linus Torvalds 在 2026 年 1 月使用 Google Antigravity 来 Vibe Code 他的 AudioNoise 项目

### 争议与风险

- **代码质量**：CodeRabbit 对 470 个开源 PR 的分析显示，AI 共同编写的代码比纯人类编写的代码多出约 1.7 倍的"重大"问题，安全漏洞高出 2.74 倍
- **可维护性**：GitClear 对 2.11 亿行代码的分析（2020-2024）发现，代码重构比例从 2021 年的 25% 降至 2024 年的不到 10%，代码复制量增加约 4 倍
- **[[ProductivityParadox|生产力悖论]]**：METR 随机对照试验（2025 年 7 月）显示，有经验的开源开发者使用 AI 编程工具实际上慢了 19%，尽管他们预测会快 24%
- **安全事件**：Replit AI agent 删除生产数据库（2025 年 7 月）、Orchids 平台安全漏洞（2025 年 12 月）等事件揭示了 Vibe Coding 的潜在危害
- **对开源的影响**：2026 年 1 月论文《Vibe Coding Kills Open Source》认为，Vibe Coding 通过降低用户与开源维护者的互动来损害开源生态系统

## 与 AI 辅助编程的区分

[[AiAssistedCoding|AI 辅助编程]] 领域的重要人物 Simon Willison 做出了关键区分：

> "如果 LLM 写了你代码的每一行，但你对每一行都进行了审查、测试和理解——那在我的定义里不叫 Vibe Coding，那叫把 LLM 当作打字助手。"

这个区分揭示了两种截然不同的实践模式：
- **Vibe Coding**：不看 diff、不理解代码、依赖运气
- **AI-assisted coding**：AI 是加速器，人是审查者，每行代码都经过理解和验证

Andrew Ng 在 2025 年 6 月对这个术语提出了异议，认为它误导人们以为软件工程师使用 AI 工具时只是"跟着感觉走"。这反映了 [[MethodologyFusion|方法论融合]] 背景下，不同实践者对同一现象的不同解读。

## 工作流模式与反模式

### 五种主流工作流模式

1. **[[SpecDrivenDevelopment|规格驱动开发]]**：先写规格说明书（spec.md），再让 AI 逐步实现
2. **测试驱动开发 + AI**：先编写测试用例，让 AI 实现代码使测试通过
3. **多代理并行模式**：同时运行多个 AI 代理处理不同任务
4. **AI-on-AI 审查模式**：使用一个模型生成代码，另一个模型审查代码
5. **开发者三类模型**：Builder（建造者）、Shipper（出货者）、Coaster（滑行者）

### 七大常见陷阱

- **盲目信任**：直接接受所有 AI 建议，不审查 diff，不运行测试
- **Vibe Coding 陷阱（FOMO 驱动开发）**：看到别人用 AI 快速出原型，自己也急着跟风，缺乏规划
- **大块代码生成**：一次性让 AI 生成整个模块或功能，导致混乱输出
- **上下文缺失**：不给 AI 提供足够的背景信息、约束条件和项目规范
- **能力幻觉（达克效应放大）**：使用 AI 工具后产生"我什么都行"的错觉
- **[[AiSlop|AI 垃圾代码]]**：大量低质量、冗余的 AI 生成代码流入代码库
- **生产力错觉**：主观感觉变快了，但实际产出质量下降或耗时增加

## 关联连接

- [[AiAssistedCoding|AI 辅助编程]]
- [[SpecDrivenDevelopment|规格驱动开发]]
- [[ProductivityParadox|生产力悖论]]
- [[AiSlop|AI 垃圾代码]]
- [[RetrievalAugmentedGeneration|检索增强生成 (RAG)]]
- [[MethodologyFusion|方法论融合]]
- [[vibe-coding-overview|vibe-coding-overview]]
- [[Andrej Karpathy|Andrej Karpathy]]
- [[SelfNarrative|SelfNarrative]]
- [[addy-osmani-best-practices|addy-osmani-best-practices]]
- [[Tiago Forte|Tiago Forte]]
