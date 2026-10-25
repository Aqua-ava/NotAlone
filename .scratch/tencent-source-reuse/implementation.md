# 腾讯记忆源码复用切片

用户于 2026-10-25 明确要求源码直接复用，允许替换无用旧模块；范围决定见 ADR-104。
来源固定 6a4bb55ea54834d8265ce52024d3e3c75db30d38；源码、MIT 和摘要在 backend-ts/src/vendor/tencent-memory。

## 范围与已确认测试接口

- 沿既有正式 runExtractionFlow、DshMemoryAdjudicationRuntime、runScenarioDocumentAgent、runProfileDocumentAgent 接入；不增加备用模型或网络发送路径。
- 在这些原有业务／模型端口验证背景/目标、统一池、L2暂存、L3增量和独立核验；使用冻结合成文字，真实外部调用为零。
- 四个源码模块按实际角色、分类、原 schema、文档来源版本与显式完成适配；保留 scope、PG、来源、删除、租约、unknown 和逐物理请求台账。
- 仅默认 direct 生成改用腾讯构建；显式历史 bounded 协议继续保留兼容，不冒充本次验收。

## 验证

- 四入口 RED→GREEN 分别验证背景/目标构建、统一池、L2工作流、L3首次/增量；冲突旧版本及重复来源另经 RED→GREEN；冲突版本发送前拒绝，共用旧来源不按新候选重复复制。
- 相关提取/裁决/L2/L3 模块首轮 141/141；新增冲突版本保护后定向 21/21。
- 当前相关套件（含提取、采纳、裁决、L2/L3）152/152，0失败0跳过，约51秒；npm run typecheck、双侧来源/许可校验和 git diff --check 通过。独立复审与根提交由迁移主会话收口。
- 真实联系人小批和实际 App/微信由迁移主会话独占执行；本切片不认证已观察失败任务恢复、真实语义质量或旧栈退役。

## 协作

- 本切片不暂存其他会话或用户文件；共享 index 和本地提交由迁移主会话统一处理。
- 预算模块由独立会话在既有 provider 物理发送前接线；本切片不绕开它，也不重建真实问题账本。
- 仅 npm run dev；不打包、不运行打包版、不 push、不建 PR、不发送外部聊天消息。

## 物理额度接线的最小配合

- `l2-scenario-model.ts` 的 finally 仅在许可已持有且 provider 明确 `before_dispatch_started === false`（或原已知预约拒绝）时走原 settle；缺失标记或已进入回调保持 unknown。
- 本会话实际 L2 共账单例 1/1，统一类型检查通过。联合诊断/宿主套件中间态为 11/12，失败是新 ACK-loss 用例对原错误 code 传播的精确断言；预算负责人最终确认中间失败来自专用 Unix 代理闭包捕获了可变 permitPath，固定 targetPermitPath 后原精确断言不变且双向 GREEN：限额前拒绝无孤儿，真实 PG 已提交但有效 ACK 丢失时零 settled 尝试、原 pending/unknown 保留；缺失新观测字段的保守用例也 GREEN。最终组合验证及冻结由预算负责人和迁移主会话收口。
