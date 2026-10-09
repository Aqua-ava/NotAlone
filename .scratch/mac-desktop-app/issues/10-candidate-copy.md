# 10：真实复制与复制后隐藏

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 09
Spec: ../spec.md

## 交付行为

把当前编辑后的候选写入系统剪贴板，成功后可隐藏小窗。

覆盖规格用户故事：33、34。

## 验收条件

- [ ] 复制使用当前编辑文本，成功才提示已复制；复制并隐藏仅在成功后隐藏。
- [ ] 失败保留编辑状态和窗口，并显示安全错误。
- [ ] 自动测试与原生剪贴板实机检查只使用合成文本；复制不触发发送、长期保存或采用。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。

- 2026-10-09：开始准备候选复制的公开页面切片，沿用真实生成与当前编辑文本；普通页面仅替换操作系统复制/隐藏边界，真实剪贴板和窗口验收继续暂停，任务保持 claimed。

- 2026-10-09：首个受限 candidate-copy 普通页实际退出1：真实生成和编辑后点击旧复制按钮，按钮仍 disabled，30秒超时为产品red。单Chrome、cleanupConfirmed=true、52次有限quiet采样active/window0、两租约absent；日志 /tmp/notalone-app-context.p9MPie/10-first-red.log。已将runtime返14，开始最小复制实现；未读取真实剪贴板。

- 2026-10-09：最小复制源已准备：具名请求只带当前联系人/请求/候选身份，文本从主进程编辑状态取得；原生入口验证本次helper caller，等待Electron44.7.0 writeText Promise完成并复核范围后才隐藏同一caller。普通PageHost只替换系统复制/隐藏边界，首片断言精确当前编辑文本。类型/构建/空白/DAG通过；首green尚待唯一runtime调度，无原生通过证据。Context7未暴露，已用Electron官方clipboard文档并与实际electron.d.ts 7035/7045的异步签名核对。

- 2026-10-09：源版本37ae6e的首个candidate-copy普通页实际1/1通过、exit0：复制接收端取得当前编辑文本，编辑与原候选快照分离。单Chrome、cleanupConfirmed=true、7次有限quiet采样active/window0、两租约absent；日志 /tmp/notalone-app-context.p9MPie/10-first-green.log。已归还runtime给14；真实剪贴板、原生隐藏及后续失败/范围场景仍待，任务继续claimed。

- 2026-10-09：在已通过的最小复制实现上准备第二个公开页面场景，系统边界一次失败后验证安全提示、编辑保留、无成功或收起，再重试核对写入完成先于收起。仅类型与构建通过，场景尚未运行，不新增产品逻辑。

- 2026-10-09：固定1c8825b…5aa3545的任务10双轴初审：Standards hard0/possible0、Spec0，P0-P3均0。聚合源3a9be09受限memory-editing-full+candidate-copy实际通过：资料编辑12/12、复制2/2，exit0、cleanupConfirmed=true、单Chrome、quiet74次active/window0、两租约absent；日志 /tmp/notalone-app-context.p9MPie/14-full-and-10-copy.log。复制系统边界仍为合成接收端，原生条件未通过。

- 2026-10-09：第三片沿现有公开桥接准备当前第二候选选择、空白禁用及参数/联系人/候选/角色越界拒绝；类型和构建通过，实际运行待串行调度，不新增产品实现。
