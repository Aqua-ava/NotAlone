# 核验 SQLite 运行时与持久化能力

Triage: ready-for-human
State: resolved
Type: research
Map: [SQLite 数据库重建设计决策地图](../map.md)
Blocked by: none

## Question

实际桌面后台由什么 Node/Electron 运行时启动，其嵌入 SQLite、驱动候选、类型、复合外键与 NULL 行为、同步阻塞和 WAL 版本限制有哪些已验证事实及待验证项？

## 已有输入

- [data-model-draft.md](../data-model-draft.md)
- [package.json](../../../backend-ts/package.json)
- [package.json](../../../desktop/package.json)
- [process.ts](../../../desktop/src/main/backend/process.ts)
- [launch.ts](../../../backend-ts/src/launch.ts)

## 完成条件

对照实际锁定／安装版本、源码和官方文档，形成适用性与限制报告；可用只读进程版本探针，不运行 App 或真实数据库；不把终端 Node 当作 Electron 内嵌版本，不提前声称某驱动已集成。

## Answer

2026-10-28 完成研究，完整证据见[SQLite 运行时与持久化能力查证](../../../research/sqlite-runtime-baseline.md)。

- 锁定与安装的 Electron 为 44.7.0；桌面后台传入 Electron 的 process.execPath，并以 ELECTRON_RUN_AS_NODE 启动。只读版本探针实测内嵌 Node 24.21.0、SQLite 3.53.4、ABI 149；不能以辅助终端 Node 代替此基线。
- 已对照 Node 官方 v24.21.0 标签文档：node:sqlite 是候选，同步调用、整型映射及连接选项须纳入后续设计。现有业务池仍用 pg；本轮未选定驱动或改依赖。
- 已查证 SQLite 复合外键、NULL、唯一键及 STRICT 的约束语义；当前 SQLite 版本按版本号不在官方记载的 WAL-reset 已知影响范围内。并发、PRAGMA 配置、异常退出和业务原子性均未因此获得验证。
- 本次实际验证仅为依赖清单读取、源码与官方文档查证、Node 模式的进程版本输出；未打开 App、创建或连接数据库、读取私人资料。仍需合成约束测试、驱动选择与实际负载验证，留给“确定物理约束、旧结构映射与切换验证方案”，不在本研究任务内提前决议。

## Comments

- 本任务只产生设计决定或事实查证；表数不是硬指标。沿用仓库隐私、手动发送和桌面热更新约束，不读取私人资料，不执行真实删库，不做远端操作。
- 研究问题已由当前开发运行时实测版本及对应官方接口说明回答；resolved 只表示这项研究完成，不表示 SQLite 业务持久化已集成或验收。
