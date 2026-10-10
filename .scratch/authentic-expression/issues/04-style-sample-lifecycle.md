# 04：表达样本的主动保存、查看和删除

State: claimed
Triage: ready-for-agent
Blocked by: None (can start immediately)

拆分标识：E04（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧03；样本管理。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-044](../../../architecture/adr/044-explicit-style-sample-retention.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

用户主动保存最终文字，查看同联系人样本并删除，后续读取与恢复不可得。

## Acceptance criteria

- [ ] 用户明确保存最终文字后能查看同联系人样本、主动删除；选择、复制或同步事件不自动保存，无发送证据保持未知。
- [ ] 手工文字和候选/消息衍生样本标明真实来源，保留原始聊天依赖；不得复制后改称无来源手动输入逃避删除。
- [ ] 保存/查看/删除是同票完整生命周期，跨owner/contact拒绝；删除或来源清理后重读、同键重试与恢复副本不可得，部分失败可重试。
- [ ] 按ADR-044将已主动保存样本作为独立对象：删助手会话仍可查看样本，只保留必要的非正文来历标识和有效原始来源依赖，不保存会话全文或从样本恢复旧讨论。
- [ ] 删除样本不删除独立聊天资料；会话删除完整组合在E06核验。保存与会话删除竞态只保留删除前成功主动保存的样本，失效候选不能在删除后重新保存；本票不让样本进入生成。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

这是最小完整数据生命周期：复制不自动保存、无证据不标已发送、来源依赖与删除同步交付。暂不让样本进入生成。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

## Answer

2026-10-11：总协调的C子Agent完成本票实现候选与来源集成修复；本轮已识别对应的既有C实现会话后，后续C票及最终组合验收由该会话负责，本子Agent只交付已完成的集成切片。保留`State: claimed`及原验收标准，不独自宣称E04全部关闭。

已实现具名保存、目录、单项读取和删除HTTP入口及生产桌面controller/bridge/panel。样本仅在用户明确保存最终文字时落库，属于owner/contact；复制或选择不自动保存，发送状态恒为未知。候选与本人消息衍生样本保留真实原始来源；已知编辑文字复制到手工框仍携原候选来历，同文多来源不按最后一次来源覆盖，手工入口存在歧义时拒绝并要求从明确候选/消息入口保存。删除样本和来源清理清除正文及传递派生结果；失效请求键只留下无正文凭证，不能同键重新生成伪装恢复。删除样本不删除独立聊天资料，无关手工样本保留。

`049_style_samples.sql`已单独本地提交`72c762d`，真实表包括独立样本、实际样本使用记录、原始来源快照及失效请求键。公开生成在首次模型前、同owner锁事务捕获当时实际使用的原始来源；提交、读取、重放、继续及保存样本复验这些已捕获来源，逐请求核验前序祖先，后继自己的新来源不能掩盖旧请求缺快照。旧有聊天来源却缺当时快照的请求失败关闭，不事后展开当前新增ref猜过去；合法手工本人记忆的owner哨兵需核验真实manual/active记录，不作任意owner引用豁免。`delete_requested`在worker完成前即遮挡/拒绝结果，包含多来源消息及跨联系人本人记忆来源。来源删除和样本读取/写入持同owner锁，不保留正文副本作来历缓存。

实际验证仅使用合成联系人、受控模型、隔离随机`_test` PostgreSQL，关闭dotenv/tracing，无外部模型或私人资料：

- `PGHOST=/tmp python -m unittest tests.integration.server.test_style_samples -v`：12/12通过，真实HTTP→正式迁移后的隔离PG；覆盖生命周期、owner/contact隔离、保存/删除重试、部分失败回滚、来源待删窗口、三类记忆的多来源、观察来源清理、模型期间新增ref不能替换旧快照、连续候选及旧parent/新child快照缺口。另复核合法manual-owner的读取和同键重放200，模型只调用一次。
- 同一随机测试库运行`test_source_deletion`、`test_observation_store`、`test_postgres_reply_store`以及`test_generator`、`test_unified_inputs`、`test_langchain_vertical_slice`、`test_skill_runtime_resources`：106/106通过。旧ReplyStore夹具补真实合成来源及首次模型前`prepare_context`，保留原时间、隔离、引用和Skill断言。
- `npm test`：TypeScript检查及40/40安全测试通过；最后纯页面导航调整后`npm run typecheck`与`git diff --check`通过。
- 总协调运行`PGHOST=/tmp npm run test:pages -- --case style-samples --timeout-seconds 180`：最终exit0、`page_test_passed`。真实公开页面→生产controller/具名桥接→HTTP→隔离PG覆盖实际message进入模型、编辑复制保存保留来源、来源删除后派生样本不可得、复制正文再次手工保存被拒绝、独立manual保留、跨contact不可见，以及两个不同origin同文时手工保存拒绝。quiet17、active0、screens0、单Chrome、`cleanupConfirmed=true`、`Electron/nativeAcceptance=false`。
- 最终业务候选`f726fe02`的独立Standards/Spec评审各0；后续测试夹具装配及合成公开状态诊断增量两轴各0。导航调整未删除或放宽原断言。

真实red→green与失败记录保留：修复前连续候选在来源待删时仍返回旧正文，合法manual-owner被误挡，旧有源parent缺快照被当作无来源并被child新来源掩盖；修复前源码副本/公开HTTP实际失败，修复后相应断言通过。页面曾真实失败于文本选择器歧义、夹具未命中实际来源、异步radio未确认选中；后续三次页面失败分别为radio操作、删除完成视图、跨contact导航。删除完成视图失败时，同一真实页面后端HTTP已完成五步清理，但夹具缺MemoryService，三个公开记忆读取503使刷新回调失败；补真实Postgres存储装配后读200、五步成功、独立manual1项保留、derived410、旧reply404、模型1次。页面失败轮的资源均已清理；radio失败quiet7/active0/windows0，删除视图失败quiet30/active0/windows0，导航失败quiet53/active0/windows0，均`cleanupConfirmed=true`，没有将失败记为通过。

本切片自动实现与验证完成，人工部分未执行。真实模型语义、自然度、“像本人”和原生App/微信均未执行，按本轮排除范围跳过；受控响应只证明数据与控制契约。A09/E06中的删助手会话后已保存样本独立保留、不能恢复旧讨论、重新连接/Skill探索/消息组/样本生成的组合，以及主C选择的最终选区粘贴适配仍待其集成验证。当前不让样本进入生成，也不关闭这些剩余原验收项。没有push、发布、部署或发送消息。
