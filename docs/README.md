# 文档入口

按当前问题选择入口；领域约束、操作说明和历史证据分别维护。

| 要做什么 | 阅读入口 |
| --- | --- |
| 从源码运行或了解当前交付状态 | [项目 README](../README.md#从源码运行)、[桌面端说明](../desktop/README.md)、[TypeScript 后台说明](../backend-ts/README.md) |
| 排查 macOS 权限、启动与环境问题 | [操作与排障记录](guides/README.md) |
| 查评测方法、提案、结果与证据 | [评测索引](evaluations/README.md) |
| 开发、验证或处理任务 | [仓库规则](../AGENTS.md)、[Agent 工作流](agents/workflow.md)、[工程工作流](agents/engineering.md)、[任务约定](agents/issue-tracker.md) |
| 理解领域词汇或核对设计约束 | [领域语言](../CONTEXT.md)、[架构索引](../architecture/README.md) |
| 查外部资料与技术比较 | [调研目录](../research/) |
| 查可复现实验实现 | [独立实验](../experiments/) |

## 文档归属

- `guides/` 保存操作说明与环境、权限、故障记录；当前命令以各工程 README 和配置为准。
- `evaluations/` 按主题保存评测材料；日期、结论、停止原因、授权范围和证据标识沿用原记录。
- `agents/` 保存 Agent 工作规则。
- 领域词汇留在根目录 `CONTEXT.md`，现行规格、决策及草案留在 `architecture/`，调研留在 `research/`，任务与规格按约定留在 `.scratch/`。

## 历史路径与证据

2026-10-26 按用途归类文档，保留原文件名；历史命令、JSON 证据、摘要和带提交身份的文件清单保持原样。旧提交中的路径可在对应 Git 版本中查询；退役源码链接及私有证据路径可能无法在当前检出中打开，私有材料继续留在原本机位置。

[核心事实保留重复测量提案](memory-claim-retention-repetition-pilot-proposal-20261005.md)仍保留在本目录：历史准备脚本直接读取该路径，冻结记录保存其路径与摘要。通过[来源核验索引](evaluations/memory/source-verification/README.md)统一导航，正文只保留这一份。

## 旧代码与文档状态

[2026-11-01 清理与保留清单](verification/20261101-legacy-code-and-docs-cleanup.md)记录当前入口核查、已删除孤立实现、仍在使用的模块、历史材料保留理由及验证限制。
