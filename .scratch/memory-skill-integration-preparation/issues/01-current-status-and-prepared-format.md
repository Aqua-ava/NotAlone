# 01：集成历史核实与准备回执格式兼容

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: None
Source unit: U1 / S源票01

## 交付行为

用户查看和使用旧资料时能分清历史与当前未核实；main的固定准备流程能保存新时间状态，并在旧格式需要重新准备时保留编辑和原任务归属。

## 范围与兼容

- 复用S历史时间/核实合同，保留main冻结上下文及显式生成；建立version=2与独立schema修订识别，后续票新增结构时显式提升修订。
- 旧格式先按原generation/attempt事务核可靠终态，或受控停止、封键和核对租约，再提示明确重新准备；当前不实现或开放后续概览/偏好字段。

## 依赖说明

无前置。本票不占新SQL号；02纠错可独立准备。

## 验收标准

- [x] 旧近况、缺少结束时间、未知聊天时间、稳定事实和明确区间分别呈现；过去正确的资料不被当作当前已证实或错误删除。
- [x] 公开准备→保存→重启→执行使用本票version=2及schema修订；旧修订、字段不支持或损坏时显式拒绝，不丢字段、不重取最新消息冒充原准备。
- [x] 旧格式已终止、仍运行、终态未知、零C及已有C失败分别验证；不遗弃旧任务、不产生第二次生成，不擅自解除有效租约。
- [x] 需要重新准备时保留用户编辑，由用户明确动作触发；准备/读取/刷新本身不调用模型或发送消息。
- [x] 来源失效/删除及晚返回覆盖固定快照、当前输入与恢复状态，既有500条历史ID范围、联系人隔离和退出凭证保持。
- [x] 最小时间/格式单元与公开HTTP生命周期回归完成，记录源码、方法、原失败、审查和Answer；仅本票验证结果可签收。

## 验证入口

沿用时间状态、assistant generation prepare/lifecycle及格式往返测试；新增旧格式仍运行/终态未知、损坏版本和新时间对象的公开准备链。

实施时读取[规格](../spec.md)、[任务图](../planning.md)、[冻结增量](../refreeze-v2.md)、[验证矩阵](../validation-matrix.md)及[来源签收证据](../acceptance-evidence.md)，再按仓库规则/领域路由读取当前约束。来源源码和原票状态一律用固定S核验，不把准备树内的旧源票状态当成当前交付。

## 执行边界

用户已明确启动实施，本票在固定M2的独立集成树领取。S分叉库保持原样。完成本票也不包含合入main、业务迁移、push/PR或部署。

## Answer

2026-10-15：固定候选`9ef25e059429799fca7e4612ff9c92ac67a784c2`及其expired终态修复已经独立Standards／Spec审查，修复后两轴均0项发现；本票签收合入本任务集成分支，6/6 AC具备证据，State标为resolved。下列合成结果不代表真实App、语义质量或整批集成通过；各轮原claimed与等待记录保留为过程事实。

### 来源与实际增量

- 仅复用源01功能提交`909ba6f2`至`db83d794`的backend／desktop增量；固定S为`54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616`，没有搬入源02以后字段或S后修复。本票从main `08c4d48e`建立，已同步集成文档tip `773a4495`。
- 历史／当期／稳定／当前未核实的读取时派生、管理历史可见性、实际模型与方向探索快照、原话和React展示贯通。源事实、采纳方式、有效期和质量门不回写，不新增SQL。
- main固定上下文使用`version=2`及`schema_revision=1`，严格值对象／字段／范围白名单；旧版、旧修订、未知字段或损坏结构不能静默补字段或回取最新消息。
- 原generation／attempt按同owner事务核对。运行中或终态未知只明确返回等待／核对；零C或可靠失败封原键后才要求重新准备；已可靠保存的完成结果沿唯一完成writer恢复。受控停止复用原interrupt凭证，晚返回不能写回旧结果。
- 新增只含原`request_key + input_version_id`的公开`preparation-format`核对入口。React的明确重新生成动作先核对旧身份，可靠终态后才准备新输入；当前编辑继续保留，读取／刷新不调用模型。main原500条历史ID范围、异步准备许可、联系人归属及删除闭包保持。

### 红绿与实际验证

所有Python命令均先激活Conda `NotAlone`，设置`NOTALONE_DISABLE_DOTENV=1`和本树`PYTHONPATH=src:..`。测试只使用自有随机合成`_test`库或夹具随机库，不读取`.env`或S库，未启动数据库服务、App、微信、探针或真实模型。

- 时间值对象原失败为缺少两项当前状态字段；3/3绿色。公开过期资料原失败为联系人／本人列表均为空；移植后源01完整相关12模块**184/184**通过，48.745秒，含当前状态HTTP20方法。
- 新codec原失败为输出v1、旧payload被接受及损坏context抛非受控TypeError；严格v2／独立修订后2/2通过。全后端unit初轮1331中1个既有模型payload期望仍为四字段，补两处明确新时间期望后最终**1331/1331**通过，14.522秒。
- 旧准备零C原HTTP返回400；加入原身份门禁后明确409。无正文核对入口原404；新增后重复核对保持同一身份。最终公开prepare＋lifecycle **37/37**通过，38.304秒，覆盖新时间对象准备／重启执行、零C、可靠C失败、仍运行、未知终态、完成恢复、受控停止及晚返回；日志中故意迟到的失效写入保持失败关闭。
- `node --test tests/prepared-format-http.test.mjs tests/memory-current-status.test.mjs`最终**2/2**通过。生产控制器／React／真实HTTP／PG验证旧准备→保留当前编辑→刷新零模型调用→明确核对→一次新生成；夹具输出`database_remaining=false`。原`explicit-generation-context-http.test.mjs`另轮**8/8**通过，冻结后新增消息、补查、删除和Skill失效路径保持。
- `git diff --check`通过。`npm test`／typecheck仍受固定M2缺失`observation-measurements-fixture`及衍生四项类型错误阻塞；本票新增类型错误已清零，未绕过该缺口。

### 原失败与未验范围

- 既有`assistant-generation-preparation.test.mjs`14/15通过；第9项同owner准备登记触发8项上限，主集成已在纯M2复现，未改其夹具。generation四组先前51项中50通过，replacement失败注入用例期望`internal_error`而实际`reply_generation_failed`，仍由主集成独立核验，未把它隐藏为通过。
- 页面CLI单元曾与02的自有页面租约重叠，状态检查期望absent但实际needs-owner-verification，10/11；没有触碰02资源或据此宣称清理成功。已停止该组，普通页面等待主Agent串行调度；未执行真实App／微信。
- 桌面新用例首轮因未传bridge要求的`newRequest`布尔字段失败，修正测试准备后进入产品路径；后轮结果已生成但本地savedSession投影尚待读取，按公开读取后断言2轮记录。上述夹具准备失败不冒充产品红。
- 本票不认证自然语言完整时态识别、真实模型质量、原生渠道、业务迁移、来源外部副本删除、部署或main合并。独立两轴审查与最终签收由主集成随后追加。

### 独立审查与过期终态修复

主集成对`051bc12a`完成独立审查：Standards为0；Spec为1项P2，原generation与最新attempt已经可靠`expired`时仍被当成终态未知，无法封旧键重新准备。新增公开HTTP回归只注入可控时钟，真实生成经过生产`_mark_attempt_expired`后取得request／最新attempt均`expired`；原核对返回`generation_unconfirmed`，形成准确失败。最小修复显式接受两者一致的`expired`，继续先排除任意running attempt、缺失或超前attempt及未知状态；schema修订、原编辑、请求身份与有效租约合同不变。

修复后该回归及running／unknown反例3/3通过；同步已双轴审查的主集成tip `64930dee`后，公开prepare／lifecycle／replacement／rejection四组最终**53/53**通过，53.181秒，codec2/2及`npm run typecheck`通过。前段记录的M2类型、队列夹具与replacement错误期望已由独立测试基底`8a93c40e`修复并单列，未由本票绕过；原失败记录继续保留。修补等待独立增量复审，State仍为claimed。未启动页面、App、微信或探针。

### 固定产品候选的单组普通页面

主Agent确认其他页面和安全测试已释放后，在产品候选`a7c8c2b2bef7dac11489f5d4bd5d4efc3b246ba3`仅执行：先激活Conda `NotAlone`，于`desktop/`运行`npm run test:pages -- --case memory-current-status --timeout-seconds 180`。构建通过，单组首次执行**1/1**通过；没有将其他窗口或来源历史结果合并成一次运行。

实际生产React页面、生产控制器及独立合成HTTP／PG核验历史／当前未核实／来源支持当期区间／稳定偏好；未列举职业和窄时段不被误证实。候选实际引用三项未核实资料并显示生成时状态，过期历史不进入生成依据；公开删除来源到成功后相关卡片和旧依据清除，独立手动稳定偏好保留。

CLI返回`cleanupConfirmed=true`，夹具正常退出并由`cleanup_fixture`对本轮随机库精确查询`database_remaining=false`；随后`test-pages.mjs --status`与`test-app.mjs --status`均为`absent`。本轮单个无头Chrome，quiet采样11次、active0、屏幕窗口0；采样RSS峰值KiB：browser1100928、node194912、backend159728，含共享页重复计算可能。`electronRun=false`、`nativeAcceptance=false`，未运行Electron、App、微信或实际探针。仅追加本段证据，产品逻辑保持冻结，State继续claimed等待主集成签收。

## Comments

- 2026-10-15：按已确认推荐方案发布；未领取、未执行。
- 2026-10-15：按后续“继续继续”在独立树领取并形成上述实现候选；仅本票文件和自有测试资源，待主集成独立审查。

- 2026-10-15：expired修复经增量两轴审查均0项发现，签收固定候选`9ef25e05`。先合入02、再逐块处理01的四个局部冲突；共享迁移夹具明确同步为001–059。最终unit1331/1331、业务Node18/18、公开HTTP/PG及迁移141/141，均0跳过；完整tsc、迁移字节和差异检查通过，详见[首批组合记录](../frontier-01-02-validation.md)。没有在本轮重跑页面、Electron、App、微信、实际探针或共享租约调度CLI，不改变已记录的单组普通页面范围。
