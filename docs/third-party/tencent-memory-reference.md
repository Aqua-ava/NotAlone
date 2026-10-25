# 腾讯记忆源码复用说明

按 [ADR-104](../../architecture/adr/104-tencent-source-memory-engine.md)，记忆核心优先直接复用 [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 的 TypeScript 源码。当前来源固定为 `6a4bb55ea54834d8265ce52024d3e3c75db30d38`；旧 Python 行为参考基线 `e9a82935b52741e0c798c75326e90b7144eb4d5f` 仅用于追溯历史决定。

源码迁入 [`backend-ts/src/vendor/tencent-memory`](../../backend-ts/src/vendor/tencent-memory/)，原文件路径与摘要见 [`upstream.json`](../../backend-ts/src/vendor/tencent-memory/upstream.json)。本切片复用四个模块的适用流程和输入构建代码，不包含整个 MemoryCore 运行时、上游存储、遥测或腾讯服务。运行时不读取本机上游检出目录。

| 上游 `MemoryCore/src/core/prompts/` 文件 | 正式入口 | 保留的实现与必要差异 |
| --- | --- | --- |
| `l1-extraction.ts` | `runExtractionFlow` 默认 direct 路径 | 背景／新消息、场景与完整记忆流程；真实双方不映射为 AI，未知和微秒时间保持，另列来源日历和文本位置，输出沿原工具 schema。 |
| `l1-dedup.ts` | `DshMemoryAdjudicationRuntime.adjudicate` | 统一候选池及逐候选关联；保留完整来源和条件，适配 add/noop/keep/update/merge；相同资料的冲突版本在模型发送前拒绝。 |
| `scene-extraction.ts` | `runScenarioDocumentAgent` | UPDATE／MERGE／CREATE、场景清单和动态输入构建；只改暂存视图，使用原 META／SOURCES 和版本替换协议，不能为配额合并无关事实。 |
| `persona-generation.ts` | `runProfileDocumentAgent` | 首次／增量、变化场景、既有画像和迭代指南；使用 `profile.md`、原 ENTRY 来源协议与显式完成，去除心理驱动力及替用户决策模板。 |

仅与原模型对话不兼容的角色、格式、分类、无关 code 模式及直接写入假设作适配。PostgreSQL、来源核验、独立语义核验、人工修正、版本事务、删除、任务租约、未知回执和逐物理请求台账继续由现有业务模块承担。显式历史 bounded 协议保留兼容用途，不因当前 direct 路径的源码替换被冒充重新验收。

测试验证本机合成输入与正式调用入口；真实联系人小批和实际桌面质量由迁移主会话统一执行，不能以源码复用或测试数量宣称通过。

以下保留参考项目许可证原文：

```text
Tencent is pleased to support the open source community by making TencentDB Agent Memory available.

Copyright (C) 2026 Tencent.  All rights reserved.

TencentDB Agent Memory is licensed under the MIT.


Terms of the MIT:
--------------------------------------------------------------------
Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
