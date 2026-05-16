---
title: "Addy Osmani"
type: entity
status: "draft"
tags: [AI编程, 软件工程, 工程管理]
last_updated: 2026-05-16
---

**Addy Osmani** 是 Google Chrome 团队的工程主管，也是 [[AiAssistedCoding|AI 辅助编程]] 领域的知名实践者和倡导者。他以其在 Web 性能优化、前端工程化以及 AI 编程工作流方面的深刻见解而闻名。

## 核心贡献与理念

Osmani 的核心立场是 **"AI 增强工程"** 而非 **"AI 自动化工程"**。他明确指出，使用 [[LLMWiki|LLM]] 编程并非"按按钮的魔法体验"，而是"困难且反直觉的"。他主张将经典软件工程实践与 AI 工具深度结合，认为当 AI 编写一半代码时，这些实践变得更加重要。

## 主要方法论

Osmani 详细阐述了其 AI 编程工作流，强调结构化、迭代和人工监督。其核心步骤包括：

1.  **先写规格说明书，再写代码**：提倡 [[SpecDrivenDevelopment|规格驱动开发]]，在与 AI 进行迭代对话后，产出包含需求、架构决策和测试策略的 `spec.md` 文件。
2.  **将工作拆分为小的迭代块**：避免一次性生成庞大代码，遵循 [[AtomicNotes|原子化]] 原则，让 AI 聚焦于单一函数或 bug 修复。
3.  **提供充分的上下文和引导**：主动将相关代码、API 文档和技术约束"打包"给 AI，以提升输出质量。
4.  **选择合适的模型**：根据不同模型的"个性"选择使用，并在必要时切换模型。
5.  **全生命周期利用 AI**：从规划、编码、测试到调试，AI 均可发挥作用。
6.  **始终保持人工参与**：将 AI 视为"过度自信且容易犯错的"伙伴，必须审查、运行和测试每一段 AI 生成的代码。
7.  **频繁提交，用版本控制作为安全网**：将 commit 比作"游戏中的存档点"，并使用 Git worktree 隔离 AI 实验。

## 对 Vibe Coding 的看法

Osmani 对 [[VibeCoding|Vibe Coding]] 持谨慎态度，将其视为一种需要警惕的陷阱。他警告，缺乏规划的 Vibe Coding 会导致技术债务快速积累，并放大"能力幻觉"。他强调，工程师的角色应从"编码者"转变为"架构师和问题定义者"。

## 关联连接

- [[AiAssistedCoding|AI 辅助编程]]
- [[SpecDrivenDevelopment|规格驱动开发]]
- [[VibeCoding|Vibe Coding]]
- [[LLMWiki|LLM Wiki 方案]]
- [[AtomicNotes|原子化笔记]]
- [[addy-osmani-best-practices|addy-osmani-best-practices]]
- [[vibe-coding-overview|vibe-coding-overview]]
- [[Andrej Karpathy|Andrej Karpathy]]
- [[Simon Willison|Simon Willison]]
- [[ai-coding-workflows|ai-coding-workflows]]
