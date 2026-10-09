# 12：候选依据与上下文核对

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 09
Spec: ../spec.md

## 交付行为

展开候选依据，核对本次使用的消息、资料及生成时快照。

覆盖规格用户故事：30、32。

## 验收条件

- [ ] 默认折叠，通过对应 owner/contact/request 的公共依据接口显示实际引用和状态。
- [ ] 依据对应生成快照，缺失、删除或时间未知如实展示，不从后来资料倒填。
- [ ] 跨范围引用被拒绝，不显示内部推理或原始错误；在真实 HTTP 业务回归中核验。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。

- 2026-10-09：接续批准的任务12，依据公开生成快照接口准备最小页面行为；当前运行资源由任务14独占，本任务先静态编写公开验收，不启动HTTP/PG或浏览器，不将未运行用例称为red/green。原生验收保持暂停。

- 2026-10-09：首片通过真实页面→生产具名控制器→HTTP/PG接缝核验：未实现展开按钮时实际red退出1；接入只读生成快照、默认折叠、候选citationIds标注和未知来源时间后green退出0，1/1通过。命令为 `npm run test:pages -- --case reply-evidence --timeout-seconds 120`。日志保存在本轮仓库外交接目录 `12-first-red.log`、`12-first-green.log`；类型、构建、空白与脚本语法检查通过。随机合成测试库/握手/配置、可控外部模型，未处理私人资料或真实渠道。
- 2026-10-09：首片green单Chrome，cleanupConfirmed=true，7次quiet采样active/window均0、activationPolicy2；自有子树RSS采样峰值Chrome855104、Node180688、Python155040 KiB，共享页可能重复计，不保证物理内存或瞬时上限。两租约absent，已释放root分配的12-pages运行所有权。只完成默认草稿快照首片，删除/范围/迟到/失败及完整相关回归、双轴评审仍待；保持claimed、未勾选验收且无Answer，原生/签名/完整App未验收。

- 2026-10-09：运行所有权已交回root后，静态准备后续八场景（安全503重试、候选/输入快照、新生成/联系人/连接迟到、HTTP与具名范围拒绝、自有请求移除404、旧快照缺时间不倒填），加首片共九场景。专属回环代理只安排传输；专属Python工具严格限制本轮随机_test库和owner/contact/request，仅安排请求移除或旧timing缺失，HTTP/页面用于断言，不证明来源删除流程完成。类型、Python静态语法和空白检查通过；后续八场景未运行，不称red/green。未再修改共享registry/PageHost/backend-fixture/run/test-pages。
