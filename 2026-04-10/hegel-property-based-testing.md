# Hegel：一个通用的基于属性的测试协议和PBT库家族

> 原文链接：https://hegel.dev
> 翻译日期：2026-04-10
> 来源：Hacker News

## 简介

**Hegel** 是一个通用的 **property-based testing（基于属性的测试）** 协议和库家族，构建在 **Hypothesis** 之上。

如果你是第一次来这里，我们建议从 [Getting started（快速开始）](https://hegel.dev/intro/getting-started) 指南开始。

## 文档结构

### Introduction（介绍）
- Getting started（快速开始）

### How-to guides（如何做指南）
- coming soon!（即将推出！）

### Explanation（解释）
- How Hegel works（Hegel 如何工作）
- Why Hegel?（为什么选择 Hegel？）

### Reference（参考文档）
- Installation reference（安装参考）
- Protocol reference（协议参考）

## 关于 Property-Based Testing

Property-based testing（基于属性的测试，简称 PBT）是一种测试方法，它不是编写具体的测试用例，而是定义属性（properties），然后让测试框架自动生成大量随机输入来验证这些属性是否成立。

Hegel 基于 Hypothesis 构建，Hypothesis 是 Python 生态系统中最流行的 property-based testing 框架之一。Hegel 的目标是提供一个通用的协议，使得不同的语言和平台都能使用统一的 PBT 方法和工具。

## 相关资源

- **hegel-rust**: Rust 实现
- **hegel-go**: Go 实现
- **hegel-core**: 核心实现

---

*本文由 AI 翻译，保留原文专业术语。*
