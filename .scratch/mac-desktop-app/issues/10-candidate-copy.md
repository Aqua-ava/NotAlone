# 10：真实复制与复制后隐藏

Type: task
State: claimed
Triage: ready-for-human
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

- 2026-10-09：聚合源c61d86c受限candidate-copy+reply-evidence实际退出0，复制3/3及依据9/9通过，cleanupConfirmed=true、单Chrome、quiet62次active/window0、两租约absent；日志 /tmp/notalone-app-context.p9MPie/12-final.log。第三片沿现有保护直接green，未虚构产品red。下一片仅安排合成系统复制迟到，验证切换联系人后不收起新会话、不发布旧提示，原已触发写入不推断为撤销；类型/构建通过，实际场景待运行。

- 2026-10-09：聚合源6005389547673144fdba53d419a0a7eca4c377a3的受限 `memory-editing-owner + candidate-copy` 实际退出0，复制4/4和资料本人单场通过；单Chrome、cleanupConfirmed=true、quiet25次active/window0、两租约absent。第四片验证复制迟到后新联系人编辑保持，旧完成无隐藏／成功／错误污染，新范围仍能复制；日志 `/tmp/notalone-app-context.p9MPie/14-fix-and-10-final.log`。固定5aa3545…60301e84的任务10增量独立Standards hard0/possible0、Spec0，P0–P3均0，原初审0保留；生产复制实现仍为37ae6e。

- 2026-10-09：准备 `tests/candidate-copy.spec.ts` 原生正向接线，沿既有受限App夹具及真实隔离HTTP/PG生成，只经公开按钮调用生产Electron复制。测试先覆盖合成占位，再比较本轮已知文本，核验编辑与原快照、manager角色拒绝、真实写入及同一helper隐藏／恢复；比较结果不回传剪贴板正文，收尾只清空仍属于本轮的已知文本。类型、差异和任务辅助检查通过；测试未运行，没有读取或写入本机剪贴板、启动App或重建签名包。普通页面证据与真实原生验收分开记录，任务继续claimed，无Answer。

- 2026-10-09：固定 `78ddb4b…485fbfaf93f4cf6d977f9ec239c21fbc8c80bd16` 的原生测试准备增量独立Standards hard0/possible0、Spec0，P0–P3均0。两轴仅只读核验门禁、当前编辑及同一小窗接线与合成数据边界，未操作App或剪贴板；不构成原生green，任务状态和验收勾选保持待实机。

- 2026-10-09（本次联系人资格适配后的普通回归）：测试准备8ff023d仅在原4场5处生成前及原生准备1处新增真实helper“确认本次联系人”按钮操作，并从具名公开状态核对当前联系人、scope及生成资格；逐文件去除新增动作后与原复制测试完全一致，保留原断言、故障/迟到安排以及先写合成sentinel、只比较本轮已知文本的原生边界。typecheck/build/diff检查通过，原生准备没有执行。FF固定干净source 0ef0527115a014c82c87f72331bb7cac222e7058，Conda NotAlone仅一次`npm run test:pages -- --case candidate-copy --timeout-seconds 180`，原4场串行4/4、CLI exit0、19.56秒；实际确认动作后验证当前编辑与原快照分离、复制失败保留及重试后收起、当前选择与参数/角色拒绝、复制迟到切换联系人不污染新范围。真实HTTP/PG及本地合成模型保持，系统复制/隐藏只在本轮合成接收边界，不把普通页面当原生剪贴板或窗口验收。仓库外只读见证沿本轮进程stdout和真实HTTP记录4个后端认证POST shutdown 200/stopped，child82895/82995/83107/83186均exit0/signalnull，instance/class cleanup均true；独立只读catalog逐场精确查询4个本轮notalone_core_flow_*_test均不存在，完整名称与场景映射保存在外部context `10-confirmed-regression-0ef0527-databases.json`。捕获64自有身份无存活匹配，6独占进程组均ESRCH，Chrome1、quiet24 active0/window0、cleanupConfirmed=true，两lease独立复查absent；日志/exit/resources/owned-identities/cleanup/independent-final保存在同前缀。精确正常收尾后已明确归还唯一runtime，没有追加组或重跑；本轮仅10 Comments事实记录，不改production。当前原生测试仍未执行、真实剪贴板/App未运行，历史评审与验收事实保留，任务claimed/noAnswer、实机条件未勾选。

- 2026-10-09（集成收尾）：在固定集成源 `d6a3e6a` 重新运行 `npm run test:pages -- --case candidate-copy --timeout-seconds 300`，确认动作复用后的原四场 4/4、exit0；4 个精确随机库不存在、自有进程无残留、单 Chrome、cleanupConfirmed=true、两租约 absent。见 `desktop/artifacts/acceptance-closeout-d6a3e6a/closeout-d6a3e6a-copy-*` 和汇总 `closeout-verification.json`。未改生产实现；真实剪贴板/原生隐藏尚未验证，保持 claimed 和未勾验收，下一步需要用户安排已暂停的原生窗口，Triage 改为 ready-for-human。
