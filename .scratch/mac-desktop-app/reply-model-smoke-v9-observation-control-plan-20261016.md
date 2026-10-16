# v9 cap1 失败观测的唯一新对照计划

日期：2026-10-16。当前仅完成准备，**未读取密钥、创建真实预算、启动 App 或请求模型**。Root 当前记忆实跑必须先关闭；本计划通过独立审查后，仍等待 Root 另行明确授权本场实际执行。不得自动启动或失败后另开场次。

本场只为取得现有 [观测接缝](reply-model-smoke-failure-observation-spec-20261016.md) 的实际 phase／errorCode／resultPresent 及无正文 inspect，区分 [旧 eb34 场](reply-model-smoke-v9-failure-result-20261016.md) 的合并 pending。旧失败、预算及证据不改；不修产品、不改变等待或认证规则。

## 冻结与准备证据

| 项目 | 本场固定值 |
| --- | --- |
| 唯一新 run | `b251dacd-ca34-49e2-9cfb-510f070b508f` |
| 冻结包 | 同 v9 `remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app`；ASAR `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021` |
| 新配置摘要 | `3a6cc8346226b787cc1e971e28175fd7a9fb8af0933ecaba374b0c34dd4d8200`；包含已审观测实现 `f3801601` 的当前验收源码 |
| 私有输出 | `desktop/artifacts/reply-model-smoke-v9-observation-control-20261016-b251dacd-ca34-49e2-9cfb-510f070b508f/`；0700，`configuration.json` 与 `preparation.json` 为 0600 |
| 准备核验 | `08:34:38Z` 完成纯配置计算、v9 ASAR 及 deep／strict 签名检查；新 run 的用户级 registry 当时不存在 |
| 旧预算 | 精确只读核 eb34 的 closed 标记、sqlite `closed=1`、预约 1；不重开、不复用 |

实际准备命令为先激活 Conda `NotAlone`，再在仓库根执行 `PYTHONPATH=backend/src:backend NOTALONE_DISABLE_DOTENV=1 python -B desktop/tests/fixtures/reply-model-smoke-backend.py --configuration e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`。此入口只计算源码／SDK／prompt／schema／合成输入配置，不读凭据、不创建预算或连接服务。源码、SDK 或包变化时须重新计算，摘要不符即停，不临时回退。

## Root 授权后的唯一执行

立即启动前重新核桌面及其他实跑已结束、交互租约无冲突，并重采真实默认目录 `~/Library/Application Support/NotAloneDesktop` 的身份及必要已知文件元数据。**该前值尚未采集**，不能用现在或旧场的 dev／ino 签未来不变；不读取、覆盖或清理非本场默认资料。重新核 ASAR／签名、新 registry 仍不存在、私有输出身份和凭据源类型权限，不提前读密钥。

沿现有 `reply-model-smoke-fixture.ts`／`reply-model-smoke-app-acceptance.spec.ts`，使用本 run 和新配置摘要；显式 `NOTALONE_REPLY_MODEL_SMOKE_APP_ACCEPTANCE=1`，其余 run、ASAR、config、output、冻结 executable 环境参数分别绑定上表。凭据源仍为已授权的仓库根 `.env` 指针，只交专用后端；不将其内容载入 App 环境。fixture 使用合成 env、独立 userData、随机 owner／contact 和隔离 PG，屏蔽 App 模型 key 与 key-file，禁 dotenv／追踪，CLI 与 probe 不可用。真实预算只由 fixture 创建并领取，随后才读取显式凭据源；不预建预算。

实际时间在 Root 授权且准备就绪时生成，仍 **5 分钟、最多 1 次启动、最多 1 次官方供应商 HTTP、零重试**：

```sh
cd desktop
npm run test:app -- --interactive --coordinator root-reply-smoke-v9-observation \
  --from <真正启动前当前UTC> --until <同一时点加5分钟> --max-launches 1 \
  tests/reply-model-smoke-app-acceptance.spec.ts \
  --output artifacts/reply-model-smoke-v9-observation-control-20261016-b251dacd-ca34-49e2-9cfb-510f070b508f/playwright
```

沿用固定合成草稿“明天我有空，晚点见。”与要求“更自然一点，保留原意，不添加新事实。”，关系语境关闭。官方 `deepseek-flash`／`reasoning_effort=none`／唯一端点 `https://api.deepseek.com/chat/completions` 不变。公开生成按钮只点击一次；完成 poll 原 30 秒、用例原 180 秒及产品运行时原 20 秒均不改，沿用全部输入／候选／依据／PG 断言。既有 runner 的源码 build 不重包 v9。

只增加已审观察的实际结果：每次 poll 保存 allowlist 状态与本地采样时间，结束或异常时尽量保存现有 inspect 的六类表计数、回复状态及供应商元数据；inspect 失败独立记录，原异常保留。HTTP 200、`reply_states=completed` 或观察文件存在都不能单独代签完整 App 成功。新增观察不保存候选正文、身份、key、token、截图或额外运行时日志；既有 Playwright 原失败上下文仍限本机私有产物，不作公开报告内容。

启动后即按 fixture 的明确目录保存 `database-owned.json`，保留准确库名／后端 PID 以便 teardown 后只读核不存在；不得读取或查询其他业务库。候选与保存断言成功、预算已 closed 后，如出现 `control-state.json` 的 `waiting-trigger/review`，立刻告 Root 同一控制目录、App PID、协调 runId 与剩余时限。Root 独占 CUA 核对同一小窗；确认后 `review.trigger` 内容必须是该 coordinator 的 runId，不能误用预算 runId。原用例随后执行既有本地编辑、公开菜单退出与 exit0 断言；不复制或发送。协调信号不认证候选、焦点或体验。

失败保留原失败和无正文观察，不重试生成、不换 key、不延长时限、不创建后继 run。成功或失败都终结持久预算，核 `closed=true, request_limit=1, reserved_requests<=1`；关闭未确认保留 unknown。核本场准确 PID／userData／fixture／测试库／租约、启动前后真实默认目录元数据及 ASAR；失败 fixture 回收不能计正常退出。原始私有产物不提交。

本计划只允许一个新对照，不触碰记忆实跑的预算或冻结源码，不启动微信、CLI、OCR、后台同步、记忆任务或外部聊天发送。新场结果只按实际覆盖认证，不改变旧失败、不自动关闭组合验收。
