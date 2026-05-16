---
title: "Addy Osmani 的 AI 编程最佳实践"
type: concept
level: 实践经验
status: "draft"
tags: [AI辅助编程, 软件开发, 最佳实践]
last_updated: 2026-05-16
---

## 概述

Addy Osmani（Google Chrome 团队工程主管）提出的 AI 编程最佳实践，强调 [[SpecDrivenDevelopment|规格驱动开发]] 和人工参与的核心地位。该方法论将 AI 定位为“增强工具”而非“自动化替代”，主张通过结构化流程和持续人工监督来提升代码质量与开发效率。

## 核心原则

- **AI 增强工程**：将 LLM 视为辅助工具，而非完全替代开发者。开发者需保持对代码的最终控制权。
- **规格先行**：在编写代码前，先与 AI 协作生成详细的规格说明书（`spec.md`），涵盖需求、架构、数据模型和测试策略。这类似于“15 分钟内的瀑布流”快速规划。
- **小步迭代**：将任务拆解为聚焦的单元（如单个函数、Bug 修复），避免一次性生成大量代码导致混乱。
- **上下文为王**：主动提供相关代码、API 文档和技术约束，使用工具（如 `gitingest`）打包上下文给 AI，提升输出质量。
- **多模型协作**：根据任务特性选择不同模型（如 Gemini 用于编码），并在模型卡顿时切换尝试。
- **全生命周期覆盖**：在规划、编码、测试、调试各阶段利用 AI，包括使用异步编码代理（如 Google Jules）后台处理任务。
- **人工审查**：将 AI 生成代码视为“初级开发者贡献”，必须阅读、运行和测试。可启动第二个 AI 会话或不同模型进行交叉审查。
- **版本控制安全网**：频繁提交（commit），使用 Git worktree 隔离 AI 实验，实现并行工作而不干扰。

## 关键引述

> “AI 编程助手是令人难以置信的倍增器，但人类工程师仍然是这场演出的导演。”

> “经典软件工程的所有实践——先设计再编码、写测试、用版本控制、保持标准——不仅依然适用，而且当 AI 编写你一半代码时更加重要。”

## 关联概念

- [[AiAssistedCoding|AI 辅助编程]]：本实践是 AI 辅助编程的具体方法论。
- [[VibeCoding|Vibe Coding]]：与“随性编码”形成对比，强调结构化流程和人工参与。
- [[LLMWiki|LLM Wiki 方案]]：可结合上下文打包技术，为 AI 提供结构化知识库。
- [[RetrievalAugmentedGeneration|检索增强生成 (RAG)]]：通过检索相关文档增强 AI 输出，与本实践的上下文提供原则一致。

## 关联连接

- [[AiAssistedCoding|AI 辅助编程]]
- [[SpecDrivenDevelopment|规格驱动开发]]
- [[VibeCoding|Vibe Coding]]
- [[LLMWiki|LLM Wiki 方案]]
- [[RetrievalAugmentedGeneration|检索增强生成 (RAG)]]
- [[Addy Osmani|Addy Osmani]]
- [[ai-coding-workflows|ai-coding-workflows]]
- [[Simon Willison|Simon Willison]]
- [[SelfNarrative|SelfNarrative]]
- [[ai-coding-spectrum|ai-coding-spectrum]]
