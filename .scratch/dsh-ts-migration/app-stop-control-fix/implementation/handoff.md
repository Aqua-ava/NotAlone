停止功能候选已冻结；不宣称原生 App 验收通过。
指定基线：283a609f5f48503657bef571c0ea9539d4ee7b76；当前共享 HEAD：2ad219758c2919597b10122af579d28ecf5b3424。
本候选 5 个产品文件在两个 HEAD 的基线相同，可独立审查 fix.patch。
根因：workspace express 确实使用原跟踪器；准备未取得 receipt 时，states() 隐藏已登记作业，prepareStarted 不推送。
精确 RED：自有 PG owner 锁阻塞准备，UI waiting，内部 preparing，主进程/小窗却只有旧 completed。
原始失败：red-preparation-tracker.public.log，约 3.8 秒；red-preparation-visibility 为另一轮相同失败。
供应商已开始的原路径本来可停止，不能把它冒充失败来源。
修复：preparing 投影/推送；真实回执前 inputVersionId/turnId 为 null；沿原登记接纳停止意图。
准备完成先确认 user_cancelled，再拒绝派发模型；未知仍 unconfirmed，不伪造取消或退出排空。
晚回执/退出先等同一用户停止，避免重复中断；没有第二套队列。
关键代码：desktop/src/main/reply/assistant-generation-jobs.ts:107、163、346、464、486。
IPC/展示：desktop/src/main/reply/bridge.ts:207；desktop/src/shared/reply-bridge.ts:27、164。
渲染：desktop/src/renderer/AssistantSessionPanel.tsx:106；desktop/src/renderer/RewritePanel.tsx:109。
直接测试：backend-ts/test/workspace-generation-stop-ipc.test.mjs:148；desktop/tests/assistant-generation-preparation-stop.test.mjs:47。
最终合成集成 2/2，相关桌面 50/50，两端 tsc --noEmit 通过；无全量重跑。
集成覆盖实际 React 工作区按钮、生产 BackendHost、窗口身份/广播、preload；Electron 传输是两个 sender 替身。
准备停止不新增模型调用；provider 阻塞停止后再放行，无晚候选落库，原 completed 候选保留。
两个最终场景均确认自有 PG 已删、宿主已退、临时业务目录已删；provider/无头 Chrome 关闭钩子成功。
最终运行前后 637 份运行源码 SHA：9237d3e3cc72830f2de49d1fc812893b01f002a79ca3c13dcf4c3dfcb02260c8，稳定。
父任务另有 host-storage.ts / business-transaction-errors.test.mjs 改动，本候选未改动、未纳入。
root-observation.json 和三个用户测试文件 SHA 未变；未改 publication、预算 bridge、任务 25/26 或其他 scratch。
真实模型/实际 App/微信/外部发送均 0；未读真实资料/.env/凭据/账本，无 add/commit/push/PR。
日志原件仓库外 0700/0600；本目录只脱敏副本、raw/public SHA 和复跑命令。
复跑：python3 .scratch/dsh-ts-migration/app-stop-control-fix/implementation/run-check.py check backend-ts --test test/workspace-generation-stop-ipc.test.mjs。
根复验：先查并复用 npm run dev；禁打包；准备等待时核对 Stop 可见可点、确认后旧历史保留且无新候选。
准备慢时 Stop 先表示停止意图，取得真实回执前保持“正在停止”，不提前报成功。
原始 App 观察没有权威阶段元数据，仍需根独占 UI 复验；记忆质量 deferred、费用输出豁免不变。
完整说明 report.md；精确七文件 SHA、证据双摘要见 manifest.json / SHA256SUMS；交接后不再编辑。
