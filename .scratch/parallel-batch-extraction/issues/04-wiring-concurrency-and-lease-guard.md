# 装配层接通批次并发与租约复验

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 02, 03

按 [spec](../spec.md) 让真实后台任务用上批次流水线：后台提取执行器与 Worker 把批次并发度透传到提取命令（默认 3，硬限 1~4，越界拒绝）；模型优先级控制的后台并发上限与批次并发度一致；Worker 的步骤租约复验回调在并行工作线程中同样生效；模型调用记账的提取范围改为运行内共享，单次调用记录仍按线程归属，停止或丢弃的调用仍补记台账。

## 验收

- [ ] 注入假运行时的装配用例：执行器按配置并发度运行，默认 3；0、5 等越界值被拒绝。
- [ ] 并发度设为 1 时装配路径完全回退串行。
- [ ] 租约失效时并行线程中的调用在写前复验失败并停止，不写入资料。
- [ ] 停止后台任务时，在途调用完成后的台账仍落地（假台账断言无丢失）。
- [ ] 现有 Worker、运行时执行与优先级用例全部通过。

## Comments

## Answer

装配层已接通批次流水线：

- `runtime_config.extraction_batch_concurrency()`：读 `NOTALONE_EXTRACTION_BATCH_CONCURRENCY`，未设置默认 3，仅接受 1~4，空串/非整数/越界抛中文 `ValueError`。
- 真实入口（后端服务与 CLI Worker）解析该值：服务端 `ModelPriorityControl(background_limit=<值>)`、执行器 `batch_concurrency=<值>`；非法配置直接以退出码 2 拒绝启动。
- `PostgresMemoryExtractionRunner` 新增 `batch_concurrency`（默认 1，1~4 校验）并透传给提取命令；直接构造执行器保持原默认，避免改变既有测试。
- Worker 在存在模型优先级控制时构造步骤租约复验工厂传给执行器；提取命令仅在并发路径的每个 worker 线程按批进入该 guard，串行路径由原外层 guard 负责，行为不变。
- 模型调用记账的提取范围改为运行内共享、单次记录仍按线程归属；停止/guard 中断时跨线程补记已返回未入原台账的调用，并与追踪终态去重。

新增 13 条测试：配置默认与 1~4 边界、执行器透传与越界拒绝、Worker 传工厂、并发 worker 线程进入 guard（≥2 个线程）、guard 失败在采纳/水位前中止、模型停止不抛 AttributeError 且台账有记录、串行路径忽略工厂、Accounted 透传、CLI 非法配置在建库前拒绝。

验证：
- 定向套件 42 tests OK。
- 全量 `tests/unit`：2597 tests，14F/5E，失败集合与改动前逐条一致，无新增。
- 串并行终态集成回归复跑 1 test OK（约 3.9s）。
- 并发相关用例重复 20 次稳定。

说明：`_build_task_host` 内部默认仍为 1，只有真实入口读取配置默认 3；如新增别的进程入口需显式传值。
