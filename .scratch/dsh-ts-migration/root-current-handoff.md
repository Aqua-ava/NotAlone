# 根迁移持续目标

最新决定先读[验收范围更新](acceptance-scope-update.md)：费用暂豁免；记忆以腾讯源码为主，允许替换重复旧模块；真实验收对象只按私有稳定身份映射。目标 active，工具不能改旧正文，不能据旧费用条件重启专属优化。

## 现状与源码

- 历史 01—24 resolved；25 claimed / not approved，26 open。腾讯替换影响的提取、采纳、L2/L3、学习及消费者必须重新验证。
- 根最后产品提交 `fc3be741`；此前 `26336555` 修复业务 JSON 保真，`8221a619` 接通实际 v2 采集。费用／对象范围 `c682a370`，腾讯源码优先范围 `019d0e2b`。
- `26336555` 回复全集 463/463；随后历史讨论 envelope 补全相关 23/23、原独立探针 3/3、typecheck 通过。原双轴正在复核 fc3be741；不能把旧全集泛化到未来源码。
- 实际 v2 runner 固定 96 本机假供应商全成功及 94成功/1失败/1取消均验证；全分母、来源、映射和未知保留。见[采集报告](resumed-v2-runner-integration/report.md)。未为费用重跑真实模型。
- 非回复准备已在 26336555 验证提取/L2/L3/学习合成切片及完整109召回/140向量兼容；完整真实矩阵、语义盲评与正式性能仍未完成，不能用假供应商认证质量。

## 当前协作边界

- 用户协调聊天已将腾讯项目拉到上级目录，固定 `6a4bb55ea54834d8265ce52024d3e3c75db30d38`、MIT；拥有四域源码复用、许可 manifest、ADR-104及架构映射，冻结后交根统一集成。
- 独立预算会话拥有 model-provider / host-model-accounting 及独立预算模块，直接复用既有 SQLite budget/rounds，接实际发送边界；不引入产品 Python 或新 PG schema，不重置旧账，不处理他人算法文件。
- 其余可见会话只处理非回复评测、宿主性能、独立源码复审和私有语义审阅；不派 sub-agent。会话 ID/职责在根私有接续台账，根独占 App/微信、真实资料和共享 index。

## 实际 App 与私有核验

- 已按 npm run dev 恢复原资料目录及五项 TS 责任；启动前核验零实例，将已确认归属且无句柄的旧空 socket 无损归档。下一轮先 dev:status 核验并复用，不开第二份。
- 当前指定联系人已唯一解析并在实际记忆页选择；同步关闭，历史 complete，记忆 partial。数量、原文、身份及私有报告都不进入仓库。
- 已只读10段原文及对应记录，独立 Agent 判4条支持/1条证据不足；有自动采纳核验充分性缺口，未证明现实主体反转。未改写真记忆，本轮真实模型调用0，未发送消息或保存视觉帧。
- 旧任务含 model_call_outcome_unknown / l2_scenario_model_failed；已核对6条已观察成功回执，但另一个 A begin 未有对应结果或未发证明，未知仍未闭合。不得换 task/window 身份盲重放。
- 私有目录别名 migration-resume-20261025：contact-resolution、initial-memory-sample、独立语义报告、call-receipt-reconciliation-input、trace-reconciliation-structure及开发日志；文件0700目录/0600数据。

## 下一步

1. 等腾讯与预算切片冻结，核验许可/来源、角色适配（双方均真人）、源码复审及实际物理上限；只按精确自有清单本地提交。
2. 原 unknown 先核回执；通过已核验的单窗口 A-only 接缝做小批，先审后采纳，不直接点击整批继续。TS预算接好且固定私有问题账本后才发真实调用。
3. 完成未豁免质量、调用/token、延迟、功能与真实记忆/App闭环；25通过后再26，正常开发最终不得依赖Python/Conda。宿主正式长采样等源码稳定且测试安静时再安排。
4. 全程只 npm run dev，不打包/运行打包版，不 push/PR，不外部发送；结束目标时正常退出自有 App并清理合成资源，保留业务资料与证据。

绝不暂存用户自有三文件：desktop/tests/fixtures/expression-preference-backend.py、desktop/tests/fixtures/expression-preferences-page.py、desktop/tests/memory-correction/retirement-react.test.mjs；不 reset/checkout/批量暂存未知证据。
