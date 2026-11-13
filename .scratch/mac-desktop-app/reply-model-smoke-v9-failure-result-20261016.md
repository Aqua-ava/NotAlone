# 冻结 v9 合成模型 App 冒烟失败记录

日期：2026-10-16。本场 **1 failed，测试耗时 37.0 秒，runner exit1**。冻结 v9 经公开“生成候选”按钮发起唯一一次官方模型请求，取得 HTTP 200、响应模型匹配；随后用例在 30 秒等待内没有观察到候选结果或 `phase=failed`，未到 Computer Use review、完成保存断言、本地编辑或正常菜单退出。**供应商 HTTP 200 不等于回复链路完整完成。** 不覆盖此前 [v6 成功场](reply-model-smoke-result-20261016.md)，不重试本场，不创建后继预算。

## 本场合同与执行

| 项目 | 固定值或实际结果 |
| --- | --- |
| 独立 run | `eb34acf8-ae5a-4613-a9e5-7917b6d5e448` |
| 当前包 | 冻结 v9；ASAR `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`；启动前及收尾 deep／strict 签名检查均成功 |
| 配置 | `621913bd8e65ae583ac2e292beeedb4f203bf94ccd47a043bb775da152f7fed2`；由现有 `--configuration <ASAR>` 纯计算入口生成，冻结源码、SDK、prompt、工具 schema 和合成输入 |
| 调度 | `2026-10-16T08:18:16.197Z` 至 `08:23:16.197Z`，5 分钟、最多 1 次 App 启动；既有 `test-app.mjs`、worker1、retries0、repeat1、max-failures1 |
| 请求合同 | 官方 `deepseek-flash`；唯一端点 `https://api.deepseek.com/chat/completions`；`reasoning_effort=none`、零重试、最多 1 次供应商 HTTP；生产运行时 20 秒上限未改 |
| 输入 | 合成联系人；草稿“明天我有空，晚点见。”；要求“更自然一点，保留原意，不添加新事实。”；关系语境关闭 |
| 隔离 | 独立 userData、合成 env、随机 owner／contact 和本场 PostgreSQL 测试库；凭据来源仅交专用后端，App 的模型 key 变量及 key-file 变量为空，兜底模型地址不可用 |
| 生成前 | 用例已通过五类表零记录断言，以及 `request_limit=1, reserved_requests=0` 断言，然后只点击公开生成按钮一次 |
| 出站 | 最终 audit 为 `responses=1`、`status_codes=[200]`、`response_model_matches=true`、`failure_kind=null`；计量与发送 JSON 规范化摘要均为 `27edf463c2a1630191f80f38e800fb2f86a128105b336220effe7db026b83673` |
| 原失败 | `reply-model-smoke-app-acceptance.spec.ts:37`，30 秒 poll 到期，期望 `completed|failed`，实际合并标签 `pending` |
| 预算终结 | 本场持久回执 `request_limit=1, reserved_requests=1, closed=true`；`budget_close_confirmed=true, cleanup_confirmed=true, unconfirmed=[]`；独立只读 sqlite 核实 `closed=1`、预约数 1 |

旧 v6 run `7c90226e-618c-4c6d-b430-991276cc98f9` 在本场开始前已核实关闭、预约 1；新 run 在准备时尚未注册。没有复用旧预算。本场预算由既有 fixture 在真实启用后创建并领取，再沿其显式凭据读取路径装配模型；准备时只检查凭据源元数据，未读取内容。

实际底层入口为激活 Conda `NotAlone` 后，在 `desktop/` 执行：

```sh
node scripts/test-app.mjs --interactive --coordinator root-reply-smoke-v9 \
  --from 2026-10-16T08:18:16.197Z --until 2026-10-16T08:23:16.197Z \
  --max-launches 1 tests/reply-model-smoke-app-acceptance.spec.ts \
  --output artifacts/reply-model-smoke-v9-20261016-eb34acf8-ae5a-4613-a9e5-7917b6d5e448/playwright
```

通过现有显式环境参数传入上述 run、配置摘要、ASAR 摘要、冻结可执行路径、私有输出目录和本机凭据源指针；未加载根 dotenv 到 App 环境。该入口实际完成例行源码 build，随后启动冻结包；未重包、未修改产品或 spec。

## 能定位的顺序与证据缺口

`pending` 是本用例的合并标签：`state.result` 存在时返回 `completed`，仅 `state.phase === 'failed'` 时返回 `failed`，其他状态全部返回 `pending`。本场没有保存逐次真实 phase、作业状态或回调事件时间。因此，失败只证明 30 秒内未被此谓词观察到候选或失败，**不能据此认定真实作业持续运行 30 秒，或生产 20 秒取消机制没有执行**。

当前已保存文件可支持以下顺序，不能补造请求／回调事件时刻：

| 原件 | 文件最后修改时间（UTC，非事件时间） | 含义与限制 |
| --- | --- | --- |
| `reply-smoke-provider.json` | `08:18:26.064033Z` | 最终 audit 已含一次 200 与模型匹配；不是供应商、SDK 或业务回调的独立时间戳 |
| `reply-smoke-closed.json` | `08:18:53.589757Z` | 失败后的预算及资源关闭回执；不是候选生成终态 |
| `run.log` | `08:18:54.147700Z` | 保留 30 秒 poll 失败和 1 failed；不是原生窗口或内部作业事件日志 |

只读代码核对得到以下边界：

1. `desktop/tests/fixtures/reply-model-smoke-backend.py:259` 的 async transport 先等待 delegate，再执行 audit response。`backend/src/notalone/memory_extraction/evaluation_http_budget.py:499` 的 delegate 在返回前完整 `aread()` 并 `aclose()` 响应。audit 只校验 JSON 中的 model，未保存 `tool_calls`、参数、SDK 解析结果或 LangGraph 终态。因此可认证本次底层响应读完及 model 匹配，**不能认证返回了有效 `ReplyRuntimeOutput`，也不能确认实际选择了哪个 Tool 或结构化输出是否被接受**。
2. 请求合同注册两个工具 schema（只读 `read_file` 与结构化 `ReplyRuntimeOutput`）并要求工具输出；cap1 是供应商 HTTP 预算，不能把这写成已证明“单个 Tool 调用完成”。本场没有保存响应内容或工具调用事件，具体工具结果为 unknown。没有第二次预约或第二次 HTTP 响应，不能由此反推第一次结构化输出成功。
3. `backend/src/notalone/reply/adapters/langchain_runtime.py:749` 用 `run_with_timeout` 包住 graph `ainvoke`；`async_runner.py:34` 的异步时限为 20 秒，外层 future 等待另有 2 秒余量。该边界不包住之前的上下文／图构建、之后的结果核验、数据库保存或桌面回读。当前 `server/app.py:1372` 的公开 `/assistant-sessions/.../replies` 在请求线程内同步等待 service 完成，保存后才返回完成正文；框架内部的模型步骤异步执行。`ReplyTimeoutError` 应映射 HTTP 504 `reply_timeout`，但本场未持久保存这个本地 HTTP 响应，是否曾产生该错误为 unknown。
4. 桌面 `reply/client.ts:126` 的正式生成请求有 25 秒本地 HTTP 时限；`reply/session.ts:1278` 之后还需核验回执、读取保存会话、满足当前视图／输入／连接守卫，才发布 result。hide／close 可以离开旧生成视图并把无结果 phase 置 idle，终态核验也可能有额外读取。上述是代码支持的可区分位置；本场没有 helper 生命周期、job 身份、HTTP 响应或 PG 完成快照，**不能把其中任何一个分支指定为实际原因**。

原件中 `error-context.md` 的页面快照来自管理页，没有候选小窗的完整状态。未进入 review，Root 没有就本场读取候选、编辑、复制或发送。`reply-model-smoke-original-failure.json` 未生成，因为 poll 已在后续 terminal 读取之前抛错；不能把该文件缺失写成没有业务错误。测试库已按既有失败收尾删除，无法再从该库恢复本场完成状态。

最小后续诊断若另行立项，应先在现有测试／fixture 接缝记录受限的 phase、job 与同请求身份的本地 HTTP／runtime／保存事件时间，确保失败前保存无正文状态；现有记录不足时先离线验证谓词与生命周期分支。此报告不实施插桩，不新增预算、请求或重跑，不改产品、spec 或 20 秒时限。

## 清理与收据更正

本场 `database-owned.json` 在库创建前由既有 fixture 落盘，在清理前已另存到本场永久产物目录；只含精确库名、后端 PID 和 planned 阶段。收尾独立查询确认该准确测试库不存在，未查询或删除其他库。

独立检查记录 runner 15856、Playwright 父进程 16065、worker 16066、专用后端 16245、App 16454 均为 ESRCH；本场 fixture 与显式 userData 均不存在，交互租约不存在。预算 registry 与失败证据保留。App 是失败 fixture 回收，不能计作产品正常菜单退出通过。收尾 ASAR 未变，deep／strict 签名检查 exit0。

**默认目录检查有一项记录错误，已独立更正：** `execution-scope.json` 与 `resource-verification.json` 最初把 `~/Library/Application Support/NotAlone` 标作默认目录。该路径前后均不存在，但当前源码实际 fallback 是 `NotAloneDesktop`。本子任务只补查到真实默认目录的收尾身份，未取得其本场启动前身份，所以默认目录前后保持不变仍为 unknown；不使用其他场次的旧身份代签。本更正在 `resource-verification-correction.json` 记录，原收据保留，其他精确进程／库／临时目录／租约检查不受影响。

## 数据范围与本机证据

只使用固定合成草稿、要求、联系人及生产提示／工具 schema。没有真实聊天、关系资料、微信、CLI、OCR、屏幕采集、复制、外部聊天发送、权限修改或远端操作。消息、来源、确认记忆、记忆候选、后台任务的生成前零记录断言通过；生成后检查未执行，不补写为通过。唯一供应商请求不重试；本场数据删除不宣称供应商已删除外部副本。

忽略目录 `desktop/artifacts/reply-model-smoke-v9-20261016-eb34acf8-ae5a-4613-a9e5-7917b6d5e448/` 保存 `configuration.json`、`preflight.json`、`execution-scope.json`、`database-owned.json`、`run.log`、`reply-smoke-provider.json`、`reply-smoke-closed.json`、两份资源核验及 Playwright 原失败上下文。目录 0700，新建本场记录 0600；原件不提交。此报告只保存脱敏结果和证据定位，不保存凭据、连接 token、候选正文或私人界面。

本场未认证 UI 候选、持久回复完成、本地编辑、正常退出、默认生产模型装配、关系语境或总体质量；不把 v6 成功迁移到 v9，不据此关闭组合验收或原票。
