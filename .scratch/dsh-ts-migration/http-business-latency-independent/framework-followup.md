# 完整宿主／最小宿主反事实的静态补充

- 2026-10-26；仅离线读取既有 `continuation/http-framework-counterfactual.json`、trace 与源码，无新 HTTP／DB／测试／模型负载。原 report、manifest、SHA256SUMS 保持冻结。
- 独立按 rows 核对全部 320 成功：4 个 host 各 80 条，包含每 GET 的10预热＋30计分。`hosts[].sample_count` 仍写120，是与实际 rows 不一致的元数据；不据该字段计数。
- 新完整／最小宿主 contacts p50 为4.344709／1.459375ms，sources 为2.187750／1.780292ms；摘要与 rows 相符。工具4文件摘要匹配绑定。此反事实明确非 gate。
- 最小入口 `minimal-contact-host.mjs:8–18` 复用业务、HostStorage 和 stringify，但省略完整认证策略、ContactHandoff 的 enter/assertCurrent、取消／移交、启动恢复、后台装配和大量模块；不能把两者差额专门归给 DSH。
- 原 launch `backend-ts/src/launch.ts:145–162` 改进程 cwd/HOME/DSH_HOME 至临时 profile；最小入口沿用合成 business home。HostStorage 的有效 HOME 则双方均来自各自相同的合成业务 home，不应据进程 HOME 不同直接推断 passfile 成本不同。
- DSH CLI 入口是 Commander＋app-boot（安装代码 `dsh/lib/bin.js:2–8,216`）；所读 cmdline `lib/index.js:50–71` 的 EOF helper 注册事件，不是此处轮询。仅凭这些静态片段不能推断全局 AsyncLocal 开销，也未据此宣称整个框架没有其他工作。
- 夹具 `resumed-host-performance/host_fixture.py:29–32,183–205` 清理继承环境，只显式设置数据库、owner、skills及4个TS角色，关闭 dotenv，没有模型 key。按 `host-reply-config.ts:68–72`、`host-model-runtime.ts:51–55` 推导 replyStatus 应 unconfigured；实际 replyStatus 未写入这份 trace，保留为推导。
- 因此 `host-plugin.ts:595` 要求 ready 的 PureTsMaintenance，以及 `host-reply.ts:249–320` 配置门内的提取 worker，不能默认已在本夹具启动。Maintenance 本身首次350ms／常态30s（`pure-ts-maintenance.ts:29–47`），也不是无等待循环。
- 反事实与独立 SQL 流程 dump SHA 相同；此前实际 scope 计划中 owner_channel_identity 为0行。`wechat-setup.ts:94–99` 无行返回null，`pure-ts-sync.ts:55–57` 无账号直接返回；按此推导本夹具没有同步周期，也不应把 CLI 轮询当成已发生的原因。
- 始终装配的具体后台候选是 `pure-ts-task-events.ts:18–35`：立即一次任务查询，完成后每1秒刷新；SSE heartbeat 仅订阅连接建立时每15秒（`pure-ts-events.ts:33`）。本夹具没有建立 SSE 订阅的请求。
- 已有完整 trace 首个带标记请求至末次 finish 约348.046ms；最小约160.454ms。缺少 ready／timer 实际执行时间，不能确认后台与慢样本重叠；一次350ms tick也不能直接解释 contacts 的持续 p50 差异。
- 静态相对 import 图近似计数：完整 host-plugin 240 个本地模块约2.89MB；最小三个入口合并去重为3个约65.7KB。规则只跟随字面量相对静态 import、跳过 `import type`，不含外部包／动态 import；它是装配量差异，不是实际 V8 heap／JIT／GC 的测量。
- 下一最小预测：若装配后的 heap／JIT／GC 或后台抢占解释差异，同一完整宿主慢样本应与这些事件重叠；若主要是公开适配，差异应集中在 ingress→认证／handoff完成→业务 handle 之前。先在保持全部功能的原 HTTP 中关联阶段和事件，不靠删后台或删范围保护得出 gate。
- 本次没有启动第二个流程，没有修改主作者文件或其元数据；不批准25或性能。详见 `framework-followup-evidence.json` 的输入／源码摘要与独立计数。
