# Standards 有限闭环复核

**结论：approve。** 只批准基线 `7a1f58a679245c6df84d88dfaafc3ff2c352c290` 到目标 `e5d8183bff811bc9bdd466a3035deb0b6abf10e3` 的同键停止最小增量；原 P2 已关闭，未发现新的具体问题。旧 7a 的 request_changes 报告和证据保持原样。

目标产品文件仅 `desktop/src/main/reply/assistant-generation-jobs.ts`，SHA256 为 `0722b752a9d2682f9e1b317942a8daeebd4ac625c133689ce45c66b5ad94adff`；另两处是已登记直接测试。作者 manifest 的 SHA256 与委派提供的 `ea04875f5f417c33ce2d106cd06711e9b967f89e084c094c3c26e44a0463172b` 一致。

## 关闭原 finding 的证据

未改动原独立 RED 的测试字节，在固定目标快照上重放：

- 作业级反例：停止选择当前 preparing 登记，`confirmed=true`、模型占位回调 0、当前停止中断 1、终态 cancelled。
- 生产 `ReplySession → IPC → preload → AssistantSessionPanel` 原反例：原请求键与可见 null 输入版本保持，`stopError=null`、生成 POST 0、中断 1、真实模型 0。

`cancelUserGeneration` 的反向匹配与 `states()` 对同键最后登记覆盖的规则一致；原连接代际、联系人、会话、请求键和非 null 输入版本条件未放宽。旧 unknown 没有因选择新作业而被删除。

## 直接新增边界

两个独立合成探针分别检查“旧真实回执先到 → 停止当前准备 → 退出”和“用户停止及重载先开始 → 旧真实回执后到”。新准备被明确阻塞，让生命周期任务实际到达等待点后才放行。

两项均确认：旧未知仍可接收严格匹配的原协议回执；当前回执到达前中断 0；真实中断确认前停止不完成、模型派发 0；确认后仅当前登记的一次 user_cancelled，重复停止复用结算；无恢复猜测、无遗留回执，旧协议不能复活已收口登记。错误连接、联系人、会话、请求和伪造输入版本仍拒绝。

新等待只收集同 owner 范围和同请求键的既有用户取消 Promise；取消本身等待准备结算与原认证中断，不等待退出／重载任务。准备回执先结算屏障，再等待取消，未发现环。无停止集合仍直接返回。

本轮独立结果为 **4 个行为探针通过**。初次运行 3 个通过，IPC 因快照遗漏同提交 tsconfig 的 JSX 配置而失败；补齐固定 Git 配置后仅重跑该 IPC，1/1。夹具失败、原件 SHA 和修正后结果分别保留，不把它当产品 RED，也未重跑已通过三项。

未跑全量、TSC、PG、模型、实际 App 或微信；root／作者的通过数字不计入本轮执行。未读取真实资料、项目 .env、原账本或私有输出；未改产品源码、用户三文件、index、旧报告、提交或远端，未创建 Agent／聊天。只有一次性 Node 合成检查，原日志仓库外 0700／0600，编译 data URL 从公开错误栈省略。精确来源、运行与双 SHA 见 source-pins.json、probes.json、ipc.json 和 manifest.json。

本结论不批准任务 25/26，也不改写 deferred 记忆质量、费用输出豁免或旧 unknown。真实桌面仍由 root 独占，只允许 npm dev，禁止打包／packaged。
