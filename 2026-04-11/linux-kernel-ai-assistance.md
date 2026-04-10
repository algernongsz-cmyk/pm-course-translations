# 向 Linux 内核贡献代码时的 AI 辅助

> 原文：[AI assistance when contributing to the Linux kernel](https://github.com/torvalds/linux/blob/master/Documentation/process/coding-assistants.rst)
> 翻译日期：2026-04-11

本文档为使用 AI 辅助工具向 Linux 内核贡献代码的 AI 工具和开发者提供指导。

## 遵循标准开发流程

协助 Linux 内核开发的 AI 工具应遵循标准内核开发流程：

- Documentation/process/development-process.rst
- Documentation/process/coding-style.rst
- Documentation/process/submitting-patches.rst

## 许可证合规要求

所有贡献必须符合内核的许可证要求：

- 所有代码必须与 GPL-2.0-only 兼容
- 使用适当的 SPDX 许可证标识符
- 详见 Documentation/process/license-rules.rst

## Signed-off-by 标签规范

**AI Agent 禁止添加 Signed-off-by 标签。**

只有人类才能合法认证开发者原创证书（DCO）。

人类提交者需负责：

- 审查所有 AI 生成的代码
- 确保符合许可证要求
- 添加自己的 Signed-off-by 标签以认证 DCO
- 对贡献承担全部责任

## AI 辅助的归属标记

当 AI 工具参与内核开发时，适当的归属有助于追踪 AI 在开发过程中不断演变的角色。

贡献应包含 Assisted-by 标签，格式如下：

```
Assisted-by: AGENT_NAME:MODEL_VERSION [TOOL1] [TOOL2]
```

字段说明：

- AGENT_NAME：AI 工具或框架的名称
- MODEL_VERSION：使用的具体模型版本
- [TOOL1] [TOOL2]：可选的专用分析工具（如 coccinelle、sparse、smatch、clang-tidy）

基础开发工具（git、gcc、make、编辑器）无需列出。

## 示例

```
Assisted-by: Claude:claude-3-opus coccinelle sparse
```
