# v9 回复 UI idle：只读定位与合成正负控

2026-10-16。[b251 实际场](reply-model-smoke-v9-observation-control-result-20261016.md)已 closed1／1，不重跑模型。本次只读代码与冻结 ASAR，并复用现有 controller／JsonClient HTTP Mock 接缝做合成对照。结论是：**已复现迟到空 saved 读取丢弃新候选的机制；另有两条不同路径也能产生 idle。b251 实际根因仍不能唯一认证。** 没有修改产品、fixture、既有断言或等待门，未运行 App／GUI／真实模型。

## 接缝与 v9 对应

复用 `desktop/tests/assistant-candidate-version-ports.test.mjs` 的既有 `fixture()`、真实 `ContactSession`、IPC／preload reply bridge、`ReplySessionController` 及既有 `records.transport` 接缝。仅在本机忽略回放文件中导出原 fixture，沿已有 `JsonClient` 访问自有回环 HTTP Mock；Mock 校验固定 Bearer token，生产 controller／回执与保存读取解析仍实际运行。它验证 controller 对给定 HTTP 响应顺序和状态的行为，**不认证生产后端认证、PostgreSQL 保存或真实模型**。

从冻结 v9 ASAR 的 `dist/main/index.cjs` 静态读取 `acceptLatestRead` 和随后 `saved.currentInputVersionId` 拒绝分支；未加载或执行 App。当前 `desktop/src/main/reply/session.ts` 经已安装 esbuild 去除 TypeScript 后，这两段与包内语句相同，差异为编译生成的 `selection4` 名称及格式。原始字节并不相等；只对这两段作语句对应，不宣称整个 live 源码与 v9 相同。ASAR仍为 `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`；当前 session.ts SHA为 `2585c103f61dc40a44c1e36d56bb65c72c36d4a76f49b51dc263503aae424ea6`。

## 四个合成控制

同一个 Node 测试覆盖下列四例，整体1／1通过、666.4ms；这里“通过”指预期机制和负控被观测到，不能写成产品缺陷已修复。每例只执行1次 Mock 正式生成 POST，没有供应商请求或新真实预算。

| 控制 | 唯一变化及公开状态结果 | 身份／权威字段等值 |
| --- | --- | --- |
| 有序正控 | 空会话读取完成，再生成并返回完成快照；waiting→ready，result=true | Mock completed turn为1；current=input、turn.request=prepared、生成input active均true |
| 迟到空读取 | 先截住旧空GET；生成Mock权威completed；截住生成自身的新鲜GET；让旧空GET先发布；最后返回新鲜GET。waiting→idle，result=false、无错误码 | Mock权威仍completed且全部等值true；旧公开saved current与生成input不等。没有切换联系人、改输入或发hidden通知 |
| 权威current已变化负控 | 在完成响应交付前，Mock权威current改为另一份合法独立讨论输入；idle、result=false | 生成turn仍completed／request匹配／生成input active，但权威current与本次input不等，必须保留拒绝语义 |
| host hidden负控 | Mock完成响应交付前调用现有公开宿主 `notifyHelperLifecycle('hidden')`；idle、result=false | Mock权威completed且原current／request／active等值；这是可控通知，不是实际窗口隐藏或OS证据 |

迟到空读取的差异只在 HTTP 交付顺序：生成自身拿到的新鲜 saved 与回执匹配，但它读期间 `this.state.savedSession` 被旧空快照替换，`acceptLatestRead` 将该“较晚发布但较旧内容”的快照视为优先，显式发布 idle 后返回。它证明这段当前实现可丢弃本应显示的本次结果。权威 current 确实不同的负控同时说明，不能直接放宽输入／来源守卫来规避问题。本次不实施修复。

`saved.currentInputVersionId` 拒绝分支与 hidden／view 失效分支也各自能复现 idle。b251 未记录相应 HTTP 身份、saved 读取交付顺序、helper 生命周期或 view／operation事件，不能从相同最终表象选择其中一个作为实际原因。真实首 idle 样本为 `09:27:02.617Z`；provider audit文件最后修改时间为 `09:27:05.124Z`，后者不是回调事件时间，也不能拿合成的 post-response 交错回填真实首次 idle 的时间或原因。

后续若需确认实际来源，只能沿既有接缝补无正文的相关性／顺序观测，区分“旧空快照晚发布”“权威current已变”和“视图失效”；不以新增模型场碰运气。本次没有新增观察 API 或改动产品。

## 原 PG 接缝失败另账

最初按许可只创建过 **1个** 自有随机测试库，试图复用现有 `withMessageOptInFixture` 的生产 HTTP／PG路径。它在 ready 前被 `message-events-backend.py:96` 的正式001–058迁移门拒绝，controller cases=0；该失败不是 UI 机制复现，没有改fixture、绕迁移门或另建PG。原失败、`cleanup-unconfirmed.json`及后端自身`cleanup_confirmed=true`分开保留。

后端70712 exit1；独立查询精确 `notalone_core_flow_a9a542e12b9049d98a999013c8610652_test` 不存在，PID ESRCH。4份自有元数据／失败文件按 dev／ino／size／SHA 保存后逐项删除，目录核身份及空后 rmdir；fixture生成的临时 bundle 目录也不存在。原高层“收尾未确认”没有改写为一次成功的 PG 回放，而独立精确资源核验已确认无残留。

无PG替代的4个自有HTTP server均已关闭，client待处理请求取消；没有第二个随机库、App、GUI、真实API或模型请求。仅创建忽略回放产物和本报告，不提交私有原件。

## 证据与命令

忽略目录 `desktop/artifacts/reply-ui-idle-diagnosis-20261016-b251/`（0700，回放与记录0600）保存 `http-mock-replay.test.mjs`、原fixture提取代码、`http-mock-results.json`（只含状态、计数、顺序、等值）、`diagnostic-summary.json`、初次PG失败回放及精确 `setup-cleanup.json`。结果记录不含联系人身份、正文、凭据或token值；回放代码只用既有合成常量，Bearer只在临时Mock内存使用。

激活 Conda `NotAlone` 后，在 `desktop/` 执行 `NOTALONE_DISABLE_DOTENV=1 node --test artifacts/reply-ui-idle-diagnosis-20261016-b251/http-mock-replay.test.mjs`。原 PG 尝试的 `replay.test.mjs` 保留1失败／cases0；不把后来 HTTP Mock 的1通过覆盖为PG通过。公共b251结果与本诊断分别留审，本子任务未自行提交。

其后主Agent将独立复现的读取交错作为[最小源码修复](reply-completion-stale-read-spec-20261016.md)完成并本地提交`9a2f42ff`，相关101/101、类型与两轴检查通过；另有未改jobs容量组基线失败如实另报。本诊断的原四控制和b251实际根因未知结论保持，修复未重包或作新实机认证。
