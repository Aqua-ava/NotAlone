# 摸底：围栏写入点分类、一致性判据、回放基线

Triage: ready-for-agent
State: resolved
Type: research
Blocked by: none

按 [spec](../spec.md) 阶段 0。不改产品代码，产出供 02 使用的判据与基线。

## 要做

1. 枚举全部 `fenceContinuity` 调用点（约 20 处，`rg -n "fenceContinuity" backend-ts/src/history/sqlite/`）和所有读写 `history_continuity_fence` / `history_guard_lease` / `history_continuity_scope` 的位置，逐个归类：A 真变化才触发（保留语义）、B 过度防御（并入元数据核对）、C 仅为修复服务（随 06 删除）。参考 `docs/verification/fence-origin-attribution-20261107.md` 与 `docs/verification/fence-root-cause-and-guard-registration-20261107.md`。
2. 写出“元数据一致”的精确判据表：账号键、会话键、来源代次、分片与表实例、文件身份各自“相同 / 仅增长 / 变化”的处理，并配反例（换账号、换会话、代次变、分片消失、分片被替换、文件身份变）。
3. 核实读取器是否支持“从各表已存最大 localId 之后读”（原生 cursor 不跨进程），指出现有增量路径（`true-delta`/`page-delta`）可复用部分与缺口。
4. 固化回放基线：用 `before-migration-43-20261107.sqlite` 的副本 + 正式 `SharedWechatClient`，重验 219 位有效联系人，期望 219/219 成功且围栏 59→59；脚本放可复用位置，输出聚合数字。

## 验收

- 调用点分类表、判据与反例表、续读可行性结论、可重复运行的回放基线脚本均已交付，写入 `docs/verification/`。
- 未改产品代码，真实库零写入。

## 约束

- 真实库 `~/Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite` 只读；演练用副本；动真实库前先备份。
- 在独立工作树改代码（dev 应用热更新会因主工作区源码变化重启）。不点任何“修复同步”。
- 报告和提交不含联系人姓名与聊天内容，联系人用编号或 `contact_id` 前 8 位。
- 本地提交（Conventional Commits，中文，无署名行），不 push。验证记录写入 `docs/verification/`，现行规格与 ADR 同步。

## Comments

## Answer

已完成并resolved：20个围栏分支A/B/C分类、18份源码三表读写面、元数据判据/反例与续读缺口均见 `docs/verification/sync-simplification-01-baseline-20261107.md`。可复用脚本 `backend-ts/scripts/verification/sync-metadata-baseline.mjs`。

命令：`node --check backend-ts/scripts/verification/sync-metadata-baseline.mjs`；按记录中的绝对备份路径运行 `--mode saved` / `--mode native` 两轮。结果均219/219成功、围栏59→59，绑定831、消息407139、目标24230、抓取141085不变；耗时64.831s / 89.337s，正文操作0。Standards/Spec独立审查均0项。

数据影响：只在临时副本由schema42正常迁移至45并续期守卫，源备份stat未变，真实库/真实App/真实读取器零操作。报告仅聚合数字。

剩余风险：正式客户端60秒打开预算在大库迁移校验时不足；回放仅将自有Worker等待延长至10分钟且保留完整校验。01不验证正文或App实际使用；02须补显式maxLocalId协议和锚点。
