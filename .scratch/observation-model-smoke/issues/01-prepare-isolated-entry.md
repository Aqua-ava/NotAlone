# 01 — 准备真实模型的隔离观察验收入口

Type: task
Triage: ready-for-agent
State: resolved

## 范围

用户于任务 01／02 完成后确认继续准备验收入口。本任务仅实现和离线验证入口，检查配置是否存在，不调用真实模型、不升级业务库或操作桌面／微信。

沿用已确认的观察存储、TaskHost、真实 PostgreSQL、HTTP 状态和候选检索接缝。单个随机联系人写入合成偏好消息，经生产宿主装配自动处理，候选默认待确认并带来源，验证重放、隔离、来源删除及关闭后旧事件。离线与未来真实模型验收使用同一场景，后者必须显式启用；正常发现测试不能因环境中有 key 就外发。模型边界替换复用现有 scripted SDK，真实模式不替换生产模型。

## 验收

- 复用自建／迁移／清理随机测试库，忽略业务与共享测试库地址。
- 缺少显式开关时，在创建数据库或模型前跳过；显式启用但缺配置时报明确错误。
- 保留默认空维度放行表，不把待确认候选伪装成自动采纳记忆。
- 记录可审阅的合成文本、接收方配置、命令、超时／重试边界、留存／清理及未验收项。
- 离线场景通过，真实调用待用户确认具体范围；Standards／Spec 评审后本地提交。

## Comments

基线 `08f8fa5`。使用 implement → TDD → code-review；不更改产品 API、数据库结构或第三方库接口。

## Answer

入口实现提交 `abd57c9`。复用观察夹具，离线模型与显式真实模型共享生产宿主、
观察发布、HTTP 状态、待确认检索、删除及关闭场景；未修改产品代码或数据库结构。
首次新用例因共用夹具尚未提供而失败，抽取夹具后场景通过；不将此记为产品缺陷。
模型配置存在性检查仅输出布尔值，随后只读取接收主机和模型名：
HTTPS `chat.ecnu.edu.cn`、`ecnu-max`。未输出 key 或完整 URL，未发起模型请求。

实际验证（先激活 Conda NotAlone，在 backend 目录）：

- `NOTALONE_DISABLE_DOTENV=1 NOTALONE_RUN_REAL_OBSERVATION_SMOKE=0 python -m unittest tests.integration.server.test_observation_model_smoke tests.integration.server.test_observation_auto_flow -v`：19 项通过，真实验收类跳过 1 项。
- 仅指定真实类、专用开关为 0 且凭据为合成占位值：0 项执行、按预期跳过；另将开关设 1、key 设空并禁止 dotenv：明确报告缺少配置，按预期失败，未创建测试库或调用模型。
- `MYPYPATH=src python -m mypy --follow-imports=silent tests/integration/server/test_observation_auto_flow.py tests/integration/server/test_observation_model_smoke.py`：两个模块通过。首次命令缺 MYPYPATH 报安装包未标注类型，补齐源码搜索路径后通过。
- `git diff --check`：通过。所有实际数据库测试均由夹具创建、迁移并清理随机 `_test` 库。

仅完成准备和离线预演。真实模型实际调用、真实微信／桌面、业务库升级与远端推送均未执行。
可审阅的外发数据、命令、费用／重试及留存边界见 [验收说明](../acceptance.md)。
下一步是用户确认该实际接收方与单条合成消息范围后，显式运行一次真实类。

## Standards

固定范围 `08f8fa5...abd57c9`，独立只读评审：0 项硬规范违反，0 项代码味道。

## Spec

独立只读评审：0 项缺失、范围越界或实现错误。两轴均无遗留问题。


后续执行记录：用户在准备结果后明确回复“可以”。按验收说明执行唯一真实模型类，
1 项通过、0 跳过，耗时 11.589 秒；生产接收方与授权一致，随机库清理已核验。
详见 [真实验收结果](../acceptance.md#本次真实验收结果)。此后续结果不改变上文准备阶段未外发的历史事实。
