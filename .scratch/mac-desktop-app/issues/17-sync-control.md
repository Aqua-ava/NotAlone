# 17：同步开关、停读与补齐

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 16
Spec: ../spec.md

## 交付行为

启停已确认范围的后台同步，查看补齐进度、暂停、失败与恢复。

覆盖规格用户故事：44、46。

## 验收条件

- [ ] 正文受运行时、总开关和 active 确认绑定共同门禁；关闭、撤销与退出停止新增读取。
- [ ] 恢复仅在原确认范围补齐，展示不完整、暂停、失败及显式重试；不推进失败游标或扩大范围。
- [ ] 与前台定位分别显示状态；权限/CLI 错误沿用安全说明，合成接缝不被描述成真实微信通道已验收。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。

- 2026-10-09：按主 Agent 安排从固定 `e1bfe74c298a37c2275c597b7f5e2f5e104df1d4` 的独立 `codex/mac-app-17-sync-switch` 领取。当前仅静态准备首条公开页面反馈与既有 HTTP 契约方案；复用任务16已确认范围和合成CLI生命周期，不重写同步算法。19独占运行，本树不启动PG／HTTP／浏览器／App；共享main／PageHost／renderer／受限登记仅交最小patch供主Agent串行处理。任务保持claimed，无Answer，验收条件未勾选。

- 2026-10-09（首片仅静态准备，未取得实际red）：新增单条共享公开场景及普通wrapper：在真实已确认A／未授权B范围中，经生产同步页的总开关开启、关闭，以真实sync状态／联系人消息接口与本轮合成CLI tail记录核对关闭成功后后续周期零新增读取，不直接读业务表。复用BindingFixture认证stopped、owned child正常退出和精确本轮库回收；未知沿既有marker／诊断保留。当前UI只有绑定授权管理、没有总开关控件，实际页面尚未运行，不能将静态缺项判断记为red／green。受限case `sync-switch`最小登记patch与后续getState／refresh／enable／disable的具名契约方案交主Agent，未编辑共享宿主、登记、BackendHost或ReplySession；先取得实际red再最小green，后续pause／retry／失败／迟到分片推进。类型、构建、42输入无原生入口的静态依赖编译、固定差异与20票字段／DAG／链接检查通过；本轮只复用获准node_modules软链，没有安装／下载或任何HTTP／PG／浏览器／App／模型／原生／私人数据操作，17继续claimed、无Answer。
