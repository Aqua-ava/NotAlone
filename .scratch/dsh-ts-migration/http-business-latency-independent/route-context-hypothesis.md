# row-text 负例后的宿主路径假设

- 2026-10-26；仅离线读取。原冻结证据及 framework 补充未改，无新 SQL／HTTP／测试／模型流程。
- 独立核对 `http-row-text-counterfactual-02.json` 全480条成功；30计分／路径／新臂的 p50 与 summary 一致：sources baseline4.539000→text4.833521ms，contacts3.656770→4.128729ms，session2.730980→2.844855ms。该结果没有支持 row-text 带来收益，也不能把阶段差值全归给该候选。
- `row-text-safety-02.json` 的11项 safety 均为true；正确性通过不证明性能收益。候选未进入生产主树的事实来自负责人通知，不据此改写源码或原有验收结论。
- 一个更小、尚未测量的假设：完整宿主的前置分派及 await 恢复排队可能占用 ingress 到业务入口的间隔；最小宿主省掉这段。没有静态证据证明它足以产生毫秒级差异，当前不是根因结论。
- 精确路径：`host-plugin.ts:259` 无条件 await `skills.privateHttp`；`skill-host.ts:87–89` 解析一次 URL 后对这两个 GET 返回false。随后 `host-plugin.ts:455` await modelRuntime.handlePublic，`host-reply.ts:367`→`pure-ts-public-api.ts:31–34` 对两 GET 返回false；最后 `host-plugin.ts:527–532` 进入 Handoff 和 ContactContext。最小宿主 `minimal-contact-host.mjs:14–17` 直接进入 ContactContext。
- 所读前置拒绝路径无数据库／文件／模型 I/O。可证伪预测：保持完整宿主全部行为，仅在同一原 HTTP 中记录 ingress、两次 await 前后、ContactContext 入口／出口和 finish；若前置阶段远小于现有差异，即排除此假设，不再用删除功能的反事实追它。此处未执行该测量。
- 另一个精确事实：安装的 `@deepseek-ai/dsh-agent/lib/index.js:325–326` 有两个 AsyncLocalStorage；所读 `.run` 调用在 `:645–654 runWithInitiator`。没有找到这三个业务 HTTP 调用它的路径；不能把 scope／cordis 未检出 hooks 解释为整个DSH没有ALS，也不能把存在ALS解释成全局开销。
- 当前仍无已证实宿主根因，不批准25／性能，不建议移除锁、revision、错误捕获、后台功能或DSH。两条精确路径已同步原任务和负责人。
