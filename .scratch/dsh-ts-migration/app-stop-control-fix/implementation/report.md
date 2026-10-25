# 工作区准备阶段的停止入口

本次交付是供根验收复测的代码候选。已找到并修复可重复的准备阶段缺口，尚不能替代原生 App 验收，也不把最初观察的精确阶段改写为已知事实。

## 已证实的问题

`RewritePanel.tsx:111` 的 `generateWorkspace` 先更新选项，再以 `newRequest: true, workspaceAction: 'express'` 调用生产生成入口。它确实进入同一个 `AssistantGenerationJobs`，没有绕过权威跟踪器。

缺口在准备回执之前：原 `states()` 仅投影 `active.receipt` 已存在的作业；`prepareStarted()` 也不通知状态变化。真实 PG 的 owner 锁阻塞准备时，内部已登记 `preparing`，但主进程及小窗订阅都只有旧 `completed`；页面显示等待、生成按钮禁用、没有停止入口。

修改前两次精确 RED：`red-preparation-visibility`、`red-preparation-tracker`。后者明确记录内部 `tracked_stages=[preparing]`，而主进程和小窗均为 `[completed]`。因此“工作区未登记”“IPC 独自漏通知”“只缺一个静态按钮”均不是此复现的原因。供应商已开始的路径在修改前就能停止；没有把这条本来通过的路径当成 Bug RED。

## 最小修复

- 继续使用原跟踪器，将已登记且具有真实请求键的准备作业投影为 `preparing` 并推送；回执尚无轮次和输入版本时明确为 `null`。
- 桌面 IPC 接受同 scope、原请求键的准备停止意图，仍拒绝其他连接、联系人、会话、请求和伪造版本。
- 原作业保存停止意图，准备完成获得真实回执后先按原连接执行 `user_cancelled`，中断未确认前不派发模型，也不发布候选。未知准备仍为 `unconfirmed`，不能伪装取消成功或退出排空。
- 退出在晚回执到达时也先等待原用户停止，避免同时发送第二次中断。只在严格未领取证明存在时允许无输入版本地结算。
- 5 个产品文件，2 个直接测试；没有修改后端协议、SQL、host-storage、publication 或预算 bridge，没有创建第二套队列。

## 可复跑检查

仓库根目录使用 `python3 .scratch/dsh-ts-migration/app-stop-control-fix/implementation/run-check.py <label> <cwd> <node参数>`。该包装仅配置本机 Node/Chrome、保存私有原件并输出脱敏副本，不启动实际 App。

- 精确 RED 命令：在 `283a609f5f48503657bef571c0ea9539d4ee7b76` 上复制新增集成测试，再在 `backend-ts` 运行 `node --test --test-name-pattern=准备等待 test/workspace-generation-stop-ipc.test.mjs`。当前修复树上同一命令应 GREEN。
- 最终工作区检查：`node --test test/workspace-generation-stop-ipc.test.mjs`，2/2。覆盖真实 React `UnifiedReplyWorkspace → useReplySession.generateWorkspace`、生产 `BackendHost`、生产窗口角色/广播适配、preload；Electron 进程传输用两个 sender 替身，不启动 Electron App。
- 准备等待：自有 PG owner 锁阻塞真实准备；停止后放行准备，第二次模型调用为 0，持久轮次为 `failed/user_cancelled`，旧完成候选仍为唯一候选。
- 供应商等待：localhost provider 保持阻塞时，输入小窗订阅有 `generating` 和可用停止按钮；停止后再放行，晚候选不落库，旧完成候选保留。
- 桌面相关 50/50：停止、执行、准备、准备停止、工作区提交与会话切换；新增 5 项针对身份、未知、严格未领取证明、重复停止和退出竞态。
- 两端 `tsc --noEmit` 通过。未运行全量 1491 或其他全套测试。

早期夹具失败、浏览器默认路径缺失、一次类型错误和一次准备停止/退出竞态的失败日志均保留；这些没有冒充原症状 RED。最终日志和命令见对应 JSON，原件与公开副本各有 SHA256。

## 数据及清理

全程只使用新建合成 owner/contact、独立 PG、临时 TS 宿主和回环供应商。真实模型调用 0，实际 App/微信启动 0，真实资料、`.env`、凭据和累计账本未访问，没有外部聊天发送。

两个最终场景均独立复查自有数据库已不存在、宿主已退出、临时业务目录已删除；provider 与无头 Chrome 的关闭钩子成功。原始日志保存在仓库外，目录 0700、文件 0600；仓库只保留脱敏副本和双摘要。

`root-observation.json`、三个用户测试文件及另三份已读取的受保护源码共 7 项初始 SHA 均未变化。没有 add/commit/push/PR，没有修改任务 25/26 或其他 scratch。

共享 HEAD 在父任务推进到 `2ad219758c2919597b10122af579d28ecf5b3424`；本候选 5 个产品文件在该 HEAD 与指定 pin 的基线完全相同。父任务的 host-storage 与事务测试改动未纳入补丁。最终两端类型检查及 2 场景测试的运行前后，637 份运行源码的总指纹均为 `9237d3e3cc72830f2de49d1fc812893b01f002a79ca3c13dcf4c3dfcb02260c8`，过程中稳定。

## 剩余验收

由根验收独占实际 App/微信和真实预算，先复用 `npm run dev`，禁止打包。确认准备等待期间可见并可点击停止、停止确认后旧历史保留且无新候选；真实准备很慢时会先显示正在停止，取得权威回执前不提前宣告成功。原生 App 的原始观察阶段未记录，仍需此次 UI 复验，记忆质量 deferred 和费用输出豁免不变。

候选已冻结；精确文件摘要和补丁见 `manifest.json`、`SHA256SUMS`、`fix.patch`。
