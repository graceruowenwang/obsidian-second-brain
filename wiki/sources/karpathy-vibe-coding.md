---
title: "Andrej Karpathy 关于 Vibe Coding 的原始推文和社区回应"
type: source
status: "draft"
tags: [VibeCoding, AI辅助编程, 编程方法论, 社区讨论]
last_updated: 2026-05-16
---

## 概述

2025年2月，[[VibeCoding|Vibe Coding]] 术语的创造者 Andrej Karpathy 在推特上发布了一系列推文，描述了一种全新的编程方式。该推文迅速引发了社区广泛讨论，特别是来自 [[AiAssistedCoding|AI 辅助编程]] 领域的专家和实践者。

## 核心观点

1. **沉浸式编程体验**：Karpathy 将 Vibe Coding 定义为一种完全沉浸于感觉、拥抱指数级增长的编程方式，编程者甚至忘记代码的存在。
2. **LLM 作为核心工具**：这种编程方式之所以可能，是因为 [[LLMWiki|LLM]]（特别是配合 Cursor Composer 的 Sonnet）已经足够强大，开发者几乎不需要手动编写代码。
3. **放弃代码审查**：Karpathy 承认自己总是点击"全部接受"，不再查看 diffs，当遇到错误时直接复制粘贴错误信息给 LLM。
4. **代码不可理解性**：随着项目增长，代码变得超出开发者的理解范围，bug 修复依赖于绕过或随机修改。
5. **适用场景限制**：Karpathy 明确指出这种方法仅适用于一次性的周末项目，并非真正的编程实践。

## 社区回应

社区回应呈现出明显的分化：

- **Simon Willison** 提出关键区分：如果开发者审查、测试并理解每一行由 LLM 生成的代码，那应被称为"把 LLM 当作打字助手"，而非 Vibe Coding。
- **Andrew Ng** 批评该术语可能误导人们，强调高效的 AI 辅助编程需要高度结构化的方法和深厚的工程经验。
- **社区实践者** 进一步区分了两种模式：Vibe Coding（不看 diff、不理解代码、依赖运气）与 AI-assisted coding（AI 作为加速器，人作为审查者，每行代码都经过理解和验证）。

## 关联连接

- [[VibeCoding|Vibe Coding]]
- [[AiAssistedCoding|AI 辅助编程]]
- [[LLMWiki|LLM Wiki 方案]]
- [[SpecDrivenDevelopment|规格驱动开发]]
- [[Andrej Karpathy|Andrej Karpathy]]
- [[addy-osmani-best-practices|addy-osmani-best-practices]]
- [[Addy Osmani|Addy Osmani]]
- [[vibe-coding-overview|vibe-coding-overview]]
- [[Simon Willison|Simon Willison]]
