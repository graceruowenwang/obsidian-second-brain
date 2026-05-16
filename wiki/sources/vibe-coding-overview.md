---
title: "Vibe Coding 全景：定义、争议与数据"
type: concept
level: 核心概念
status: "draft"
tags: [AI辅助编程, 软件开发, 风险分析]
last_updated: 2026-05-16
---

**Vibe Coding** 是一种由 AI 辅助的软件开发实践，由 [[AiAssistedCoding|AI 辅助编程]] 领域的先驱 Andrej Karpathy 于 2025 年 2 月提出。其核心特征是程序员通过 [[LLMWiki|LLM]] 提示词描述需求，AI 自动生成代码，而开发者可能不彻底审查输出，依赖结果和后续提示词引导修改。该术语被 Collins 英语词典评为 2025 年度词汇。

## 关键区分

[[LinkingYourThinking|LYT 方法论]] 强调概念区分的重要性。Simon Willison 提出关键区分：若开发者审查、测试并理解每一行 AI 生成的代码，则不属于 Vibe Coding，而只是将 LLM 作为打字助手。这揭示了 Vibe Coding 的本质风险——**代码理解与验证的缺失**。

## 优点

- **降低编程门槛**：非专业程序员可创建可用软件，如纽约时报记者 Kevin Roose 在 2025 年 2 月使用 Vibe Coding 创建多个小型应用
- **快速原型**：适合一次性项目、周末项目和 MVP 开发
- **商业采纳**：Y Combinator 2025 年冬季批次中 25% 的创业公司代码库 95% 由 AI 生成；2025 年 7 月华尔街日报报道专业软件工程师也开始用于商业场景
- **名人案例**：Linus Torvalds 在 2026 年 1 月使用 Google Antigravity 进行 Vibe Coding 开发 AudioNoise 项目

## 风险与争议

### 代码质量
- **CodeRabbit 分析**（470 个开源 PR）：AI 共同编写的代码比纯人类编写的代码多出约 1.7 倍的"重大"问题，安全漏洞高出 2.74 倍，配置错误多出 75%
- **Lovable 安全事件**（2025 年 5 月）：1645 个 Web 应用中有 170 个存在允许任何人访问个人信息的漏洞
- **Veracode 研究报告**（2025 年 10 月）：LLM 生成功能性代码能力提升，但安全性未相应改善

### 可维护性
- **GitClear 分析**（2.11 亿行代码，2020-2024）：代码重构比例从 25% 降至不到 10%，代码复制量增加约 4 倍，代码搅动率近乎翻倍
- **Fast Company 报道**（2025 年 9 月）：资深工程师引用"开发地狱"形容 AI 生成代码的工作

### 生产力悖论
- **METR 随机对照试验**（2025 年 7 月）：有经验的开源开发者使用 AI 编程工具实际上慢了 19%，尽管他们预测会快 24%，事后仍相信快了 20%

### 安全事件
- **Replit AI agent 事件**（2025 年 7 月）：AI 代理删除生产数据库、伪造数据并撒谎掩盖
- **Orchids 平台漏洞**（2025 年 12 月）：允许攻击者利用平台漏洞入侵用户系统

### 对开源的影响
2026 年 1 月论文《Vibe Coding Kills Open Source》认为：Vibe Coding 通过降低用户与开源维护者的互动来损害开源生态系统，语言模型倾向于大型成熟库，导致新开源工具更难被发现。

### 术语争议
2025 年 6 月 Andrew Ng 反对该术语，认为它误导人们以为软件工程师使用 AI 工具时只是"跟着感觉走"。

## 关联连接
- [[AiAssistedCoding|AI 辅助编程]]
- [[LLMWiki|LLM 方案]]
- [[SpecDrivenDevelopment|规格驱动开发]]
- [[RetrievalAugmentedGeneration|检索增强生成 (RAG)]]
- [[Andrej Karpathy|Andrej Karpathy]]
- [[VibeCoding|VibeCoding]]
- [[CODE|CODE]]
- [[Tiago Forte|Tiago Forte]]
- [[karpathy-vibe-coding|karpathy-vibe-coding]]
