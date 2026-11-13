# v9 cap1 新观测对照：后端 completed、UI idle

2026-10-16，按[唯一新对照计划](reply-model-smoke-v9-observation-control-plan-20261016.md)执行一次，**1 failed、36.8 秒、runner exit1**。原 30 秒完成谓词仍失败。新增观测成功保留：UI 先 waiting 后 idle，始终无 result；失败后的只读 inspect 显示本场唯一 `reply_request` 状态为 completed。两者分层记录，**不宣根因、不认证完整 App 生成成功**。旧 [eb34 失败](reply-model-smoke-v9-failure-result-20261016.md)保持；本场已永久闭账，不再开模型场。

## 固定合同与启动前核验

| 项目 | 本场事实 |
| --- | --- |
| 新 run | `b251dacd-ca34-49e2-9cfb-510f070b508f` |
| 包 | 同冻结 v9；ASAR `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`，启动前及结束后 deep／strict 签名均通过 |
| 配置 | `3a6cc8346226b787cc1e971e28175fd7a9fb8af0933ecaba374b0c34dd4d8200`；真正启动前重新执行纯 `--configuration`，与已审新观测配置匹配 |
| 调度 | `09:26:53.784Z–09:31:53.784Z`，5 分钟、max1；既有 `test-app.mjs --interactive`，worker1／retries0／repeat1／max-failures1；源码 build 后仍启动冻结包，未重包 |
| 先决条件 | Root 明确授权前一记忆场已 closed；本场新 registry 尚不存在、旧 eb34 closed1／预约1、租约无冲突。凭据源只核类型／本人权限与大小，准备及前检未读内容 |
| 默认目录 | 真正启动前 fresh 采集 `NotAloneDesktop` 目录与 4 个已知文件 metadata；未借旧错误路径或其他场 baseline |
| 合成输入 | 草稿“明天我有空，晚点见。”，要求“更自然一点，保留原意，不添加新事实。”；关系语境关闭 |
| 模型合同 | 官方 `deepseek-flash`／`https://api.deepseek.com/chat/completions`／`reasoning_effort=none`；cap1、零重试；产品20秒、完成poll30秒、用例180秒均未改 |

沿现有专用 fixture 创建并领取新预算，再读取显式凭据源。App 使用合成 env、独立 userData、隔离 PG 及随机合成 owner／contact；App 模型 key 与 key-file 变量为空，CLI／probe 不可用，禁 dotenv／追踪。只点击一次公开“生成候选”。生成前五类表均0、预算预约0的原断言已通过。

## 实际观察与原失败

观察文件共 **32 样本：waiting3、idle29**，无 readFailed，所有 errorCode 为 null、resultPresent 为 false；`pollState=failed`、`persistenceFailed=false`。这些是各次本地采样收到的状态，不把样本间隔认作连续原生焦点或内部回调轨迹。

| 本地观察时间（UTC） | 实际值 |
| --- | --- |
| `09:27:01.752Z` | 首样本 waiting，无 result／错误码 |
| `09:27:02.617Z` | 首次观察 idle，距首样本865ms；不据此推定内部切换精确时刻 |
| `09:27:30.895Z` | 末样本仍 idle；首末样本跨度29.143秒 |
| `09:27:30.915Z` | 异常后的既有 inspect 成功返回；不是生成完成时间 |

原异常在 `reply-model-smoke-app-acceptance.spec.ts:104`，30 秒 poll 期待 `completed|failed` 而收到合并标签 pending。新增观察没有改变这个谓词或替它制造 completed，原异常重新抛出。未进入后续 terminal、候选、认证 GET／助手会话完成、依据类型、本地编辑或正常菜单退出断言；没有 review trigger 或 Root CUA 候选核对。

inspect 的六类计数为：message／source_document／confirmed_memory／memory_candidate／background_task 均0，reply_request 为1；`replyStates=['completed']`。其代码查询的是 **`public.reply_request.state`**，不能改写为已验证助手会话 turn、候选 UI 或完整产品链路都完成。此观察说明本场后端回复记录 completed 与桌面无结果 idle 同时可见；具体 UI 分支、来源核验、助手会话状态与回调时序仍缺证。

供应商 audit 为1次响应、HTTP200、响应 model 匹配、failure_kind=null；计量和实际发送 JSON 的规范化摘要均为 `16a4c96fe1766accd7cc7adb2a70cf04b2d3f3b888fe6e61d90187d3466567aa`。原请求／响应正文和 tool_calls 没有新增记录，不以200或provider audit无错误代签图、Tool及桌面完成。具体根因另行只读／合成定位，本场不修改产品或等待门。

## 精确闭账与清理

本场数据库归属在 fixture 清理前已另存，只含准确随机库名、后端 PID 和 planned 阶段。失败 fixture 关闭后，独立只读查询确认该准确库名不存在；未访问其他业务库。

最终回执 `request_limit=1, reserved_requests=1, closed=true`，`budget_close_confirmed=true, cleanup_confirmed=true, unconfirmed=[]`。独立 SQLite `mode=ro`／`query_only=1` 核唯一 closed1、requests1 和 closed 标记；registry 与失败证据保留，没有剩余额度可重开。

`09:28:34Z` 独立核 runner64537／Playwright父64575／worker64576／专用后端64580／App64608 全部 ESRCH，准确测试库、显式 userData、fixture、交互租约均 absent。App 为失败 fixture 回收，不认证正常菜单退出。收尾 ASAR 未变，签名 strict0。

本场实际 `NotAloneDesktop` 的目录及4个已知文件 metadata 与本场 fresh 启动前值相等。只认证所查 metadata，不认证整个目录内容未变；未读、覆盖或删除其正文。此次正确采样不补写旧 eb34 缺失的真实默认目录前值。

## 数据与证据

固定合成草稿及生产提示／schema 通过唯一官方请求处理；没有真实聊天、关系资料、微信、CLI、OCR、屏幕采集、外部聊天发送、复制、权限修改或远端操作。新增观察只含 allowlist 状态、时间与计数；既有原失败上下文仍为本机私有产物。测试库删除不代表供应商外部副本已删除。

忽略目录 `desktop/artifacts/reply-model-smoke-v9-observation-control-20261016-b251dacd-ca34-49e2-9cfb-510f070b508f/` 保存配置／准备／真正执行范围、精确数据库归属、run.log、provider／closed回执、资源核验及 Playwright 的 `reply-model-smoke-completion-observations.json`。目录0700，本场新增记录0600，原件不提交。公共报告不放凭据、token、联系人身份、locator 或候选正文。

本场只补足实际 phase 与 inspect 分层，未认证根因、UI候选、助手会话完成、正常退出、默认生产模型装配或质量；不关闭原票或组合验收，不自动后继。
