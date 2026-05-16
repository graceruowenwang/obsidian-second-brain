---
title: "SpecDrivenDevelopment (规格驱动开发)"
type: concept
level: 方法框架
status: "draft"
tags: [AI编程, 工作流, 软件工程]
last_updated: 2026-05-16
---

**SpecDrivenDevelopment (规格驱动开发)** 是一种在 [[AiAssistedCoding|AI 辅助编程]] 中，先通过迭代对话生成详细规格说明书（spec.md），再基于规格逐步编码的软件工程方法。

## 核心原则与工作流

SpecDrivenDevelopment 的核心在于将传统软件工程中的"先设计再编码"原则，与 AI 的快速迭代能力相结合。其典型工作流分为五个阶段：

1. **问题定义阶段**：开发者与 AI 进行多轮迭代对话，深入探讨需求、约束条件和边界情况，确保对问题有共同理解。
2. **产出规格说明书**：生成一份结构化的 `spec.md` 文件，内容涵盖功能需求、[[KnowledgeCompilation|知识编译]]后的架构决策、数据模型、API 设计以及测试策略。这份文档是后续所有工作的"蓝图"。
3. **生成项目计划**：将规格说明书中的实现拆解为逻辑性的、小粒度的任务，形成可执行的步骤列表。这借鉴了 [[MethodologyFusion|方法论融合]] 中任务拆解的思想。
4. **逐步编码**：每次只执行计划中的一个步骤，让 AI 生成对应代码，避免一次性生成大块代码带来的混乱。
5. **测试验证**：每完成一个步骤，立即运行测试进行验证，确保代码符合规格要求。

## 与 Vibe Coding 的对立

SpecDrivenDevelopment 在理念上与 [[VibeCoding|Vibe Coding]] 形成鲜明对比。后者强调"跟着感觉走"，接受 AI 生成的代码而不进行审查，而 SpecDrivenDevelopment 则强调**结构化规划**和**人工审查**。

> [原创] 两者的核心差异在于**控制权归属**。SpecDrivenDevelopment 将人类工程师置于"导演"位置，AI 是执行者；而 Vibe Coding 则将控制权让渡给 AI，人类退化为"观众"。这种差异直接导致了代码质量和可维护性的巨大分野。

## 优势与适用场景

SpecDrivenDevelopment 的优势在于：

- **降低认知负荷**：通过规格说明书将复杂问题结构化，工程师无需在编码过程中同时思考架构和实现细节。
- **减少 [[AiSlop|AI 垃圾代码]]**：明确的规格和逐步编码策略，有效避免了 AI 生成不一致、冗余代码的问题。
- **提升可维护性**：规格说明书本身成为项目文档的一部分，便于后续维护和团队协作。
- **规避 [[ProductivityParadox|生产力悖论]]**：通过结构化流程和测试验证，用客观数据衡量效率，而非依赖主观感受。

该方法特别适合**复杂项目**、**团队协作**以及**需要长期维护的生产级代码**。对于一次性原型或周末项目，Vibe Coding 可能更高效，但对于需要可靠性和可维护性的场景，SpecDrivenDevelopment 是更优选择。

## 关联连接

- [[AiAssistedCoding|AI 辅助编程]]
- [[VibeCoding|Vibe Coding]]
- [[KnowledgeCompilation|知识编译]]
- [[MethodologyFusion|方法论融合]]
- [[AiSlop|AI 垃圾代码]]
- [[ProductivityParadox|生产力悖论]]
- [[ai-coding-spectrum|ai-coding-spectrum]]
- [[Addy Osmani|Addy Osmani]]
- [[ai-coding-workflows|ai-coding-workflows]]
- [[addy-osmani-best-practices|addy-osmani-best-practices]]
- [[SelfNarrative|SelfNarrative]]
