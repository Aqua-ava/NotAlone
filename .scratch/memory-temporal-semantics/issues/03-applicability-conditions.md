# 03：保留记忆适用条件及其依据

Triage: ready-for-agent
State: resolved
Type: task

Blocked by: 01

交付：用户能看见资料适用条件、其来源及不确定性；条件在概览、背景、画像和回复中完整保留。出现相反条件证据时，不自动推导原禁忌已撤销。

验收：合成“出差期间不便通话” → 提取／核验 → 页面及回复依据；条件缺失、条件被删、同范围与跨范围来源、旧数据缺条件、手动修正均验证。本票建立条件表达与安全使用；跨版本自动更新由 04 完成。

## Acceptance criteria

- [x] 本票上述完整行为已从正式流程传递到 API、页面、分层资料及回复冻结／恢复依据。
- [x] 新旧合同兼容、来源删除、联系人／本人隔离和未知语义有合成回归。
- [x] 沿已确认公开测试边界完成单例 red → green、相关回归和类型检查。
- [x] 记录真实命令、结果、数据影响与未验范围，未将脚本模型通过冒充真实模型质量。

## 执行约束

规格见 [spec](../spec.md)，实现入口见 [exploration](../exploration.md)，依赖见 [拆分](../ticket-proposal.md)。工作流、工程、领域与本地任务规范按仓库入口读取。仅修改本票文件，适配同时进行的任务。桌面仅使用 npm run dev，先核对并复用开发实例，禁止打包。没有授权进行真实存量重提取、业务数据迁移、远端操作或外部测试消息。测试用隔离合成资料。每个切片 TDD，提交中文本地 commit；基于并合入集成分支，完成后由集成负责人统一评审与验收。

## Answer

已实现独立版本一 `conditions`：逐项保存限定正文、原消息位置及独立来源支持结果；当前是否满足始终未知。直接提取和独立核验贯穿候选、联系人／本人资料、版本身份、分层引用、回复输入、冻结／恢复及删除。旧记录缺字段保持空，不回填旧快照。092仅增加兼容列，未迁移真实业务数据库。

手动修正未传字段时保留限定原文但撤去原支持标记；显式空清除，新条件按未核验提案保存。条件不同的自动替代、含条件父的自动合并保守拒绝，后续有据更新由04处理。来源支持不认证现实条件；条件结束不代表禁忌撤销。界面可查看、编辑、清空条件，来源沿已有入口核对，不显示原始UUID或字符偏移。

实际验证：`test_memory_conditions` 8个真实隔离HTTP/PG用例通过；原时间与冻结依据22例、本人分层安全9例、退役生成11例通过；`unittest discover -s backend/tests/unit -t backend` 2348例通过。桌面 `npm run typecheck`、相关64例、冻结恢复单例、真实HTTP分层依据React单例通过。新增HTTP测试先记录独立条件槽拒绝、本人丢失字段和手修丢失限定的red，再完成green。旧本人管理范围用例在HEAD原源码可独立复现，未将其计为本票新增失败。

本人分层旧夹具最初因缺测试库环境变量未执行；在自有随机库显式设置 `NOTALONE_TEST_DATABASE_URL`、`NOTALONE_DATABASE_URL` 和 `NOTALONE_EXPECTED_TEST_DATABASE` 后9例通过，测试库已清理。

本票未启动原生App或打包；父任务统一完成 `npm run dev` 原生验收。工程用例使用脚本模型，不证明真实模型语义准确率。

## Comments

2026-10-20 用户明确同意四票拆分及测试范围，发布为 ready-for-agent。


2026-10-20 实现测试夹具：`backend/tests/integration/server/test_memory_conditions.py` 的 `MemoryConditionsHttpTest.import_condition` 经真实导入HTTP准备合成“出差期间不便通话”。原生验收可 `C.setUpClass(); fixture=C(); fixture.setUp()`，调用 `fixture.import_condition(original="出差期间不便通话。", claim="出差期间不便通话。", when="2024-02-01T10:00:00+08:00", subject="contact")`（本人用 `subject="self"`）；用现有桌面夹具适配器连接 `fixture.backend`。保持进程存活，退出时 `fixture.doCleanups(); C.doClassCleanups()` 清理HTTP、临时文件与随机测试库。不得连接真实业务库。
