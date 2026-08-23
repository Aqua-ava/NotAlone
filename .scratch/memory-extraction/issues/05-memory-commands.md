# 05 — 记忆命令族与台账接线

**What to build:** 命令行入口族：提取命令（自动判断全量/增量：联系人从未提取过→全量分批滚动，提取过→从水位只提新增；断点安全重跑）接出站台账；手动录入命令（manual 标记，支持联系人级与 owner 级）；列出记忆命令；删除记忆命令（软删除留指纹）。终端只输出统计与状态。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 04（写入裁决）

- [x] 提取命令自动判断全量/增量并以水位断点续跑；已提取部分重跑自动跳过
- [x] 单批消息窗口上限为显式常量；分批串行执行
- [x] 提取与裁决的外部调用三态落台账，含 provider、模型名、token 与延迟
- [x] 手动录入命令：文本+分类+主体+联系人（或 owner 级）经 MemoryPort 标 manual 入库
- [x] 列出命令：按联系人或 owner 列出记忆（含状态、来源、采纳标记、版本历史），不打印正文以外的敏感信息格式与既有命令一致
- [x] 删除命令：软删除留指纹，删除后检索不可见
- [x] 终端输出只含统计与状态；更新 README 记录命令用法与边界

## Comments

## Comments（实现记录）

- 2026-08-23 完成。四个命令入口注册 pyproject：notalone-extract-memory（自动全量/增量、水位断点续跑、批窗口上限常量 500、批间串行、台账三态、纯统计输出、失败批计入 failed_batches 且水位照常推进）、notalone-memory-add（manual 标记、联系人级经 candidate→confirm、owner 级直写）、notalone-memory-list（状态概览不含正文）、notalone-memory-delete（软删除留指纹）。
- 提取核心逻辑抽为可测的 run_extraction（水位过滤、分批、统计聚合），4 个单元测试覆盖全量分批、增量续跑、水位缺失回退全量、失败批计数与水位推进；CLI 组装（模型/存储/消息加载）在 cli_support，真实链路由 06 冒烟验证。
- 联系人或 owner 不存在时明确报错且不触发外部调用；无消息时直接输出零统计。README 记录命令用法与边界。全量 235 例通过。
