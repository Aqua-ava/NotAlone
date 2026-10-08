# 06：联系人选择与双窗口隔离

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 02
Spec: ../spec.md

## 交付行为

从真实联系人列表选择本次对象，两个窗口同步联系人，切换后清除旧草稿和候选。

覆盖规格用户故事：15、16、19、20、21。

## 验收条件

- [ ] 使用内部 contact_id 及后端运行 owner 范围；联系人及资料状态真实可见。
- [ ] 同一联系人隐藏恢复保留本次临时编辑；切换清空，迟到的响应和事件不能串人。
- [ ] 未提交草稿和编辑文本不跨重启保存；使用两个合成联系人及另一 owner 进行公开 App 操作验证。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。
- 2026-10-08：开始实现；沿用已批准的真实 App 操作与后端 HTTP 接缝，以随机新建 `_test` 库、两个合成联系人及另一 owner 验证。联系人目录复用任务 05 的 main 认证 JSON 传输；候选生成与 SSE 接线由后续任务继续，不新增 contacts CRUD。
- 2026-10-08 阶段检查点：在 Conda `NotAlone` 与本工作树 `backend/src` 下，App 启动真实 `notalone.server.command`，随机新建并迁移合成测试库。公开 `GET /api/contacts` 返回本 owner 的两联系人及 `2/1`、`1/1` 消息/来源摘要，另一 owner 未出现；`npx --no-install playwright test tests/contact-session.spec.ts --output=artifacts/06-red-directory` 因可见联系人目录缺失取得 red（1 failed，12.6s）。随后完成独立目录投影、临时会话模块及双窗口 UI，尚未接入 05 Host；`npm run typecheck` 与 `npm run test:app`（3 passed）通过。本轮库、配置与 App 均按隔离范围回收。等待 05 正式合入后继续 green 和打包验收；未完成评审，保持 claimed。
- 2026-10-08 正式接线：保留本任务独立模块后 FF 合入已评审的任务 05，基点为 `0a6932e7db04df8c80107d0c111ad5f8a6675685`。只通过 main 的具名联系人适配器调用正式 Host `requestJson` / `getConnectionGeneration`；同一连接真实核对 `runtime_owner_configured` 后读取目录，模型密钥缺失不影响联系人阅读。main 内存会话使用目录请求代际与临时 scope，两个窗口仅获得联系人 ID、名称、真实消息/来源计数及当次草稿；Host、setup、restart 源码保持正式基点内容。
- 2026-10-08 实际 red/green：原目录 red 在接线后 green（`tests/contact-session.spec.ts --output=artifacts/06-green-directory`，1 passed，4.7s），两窗隐藏恢复和 A→B→A 清空 green（`--grep '两个窗口' --output=artifacts/06-session-first`，1 passed，5.5s）。真实后端传输边界延迟的旧目录失败曾在切换后清空新草稿（`tests/contact-stale.spec.ts --output=artifacts/06-red-stale-failure`，1 failed，9.1s）；切换同时撤销旧目录请求后同一行为 green（`--output=artifacts/06-green-stale-failure`，1 passed，5.8s）。随后覆盖迟到成功/失败、断线恢复、同库另一 owner 的连接更换、目录外 ID 与过期草稿拒绝、真实本人未就绪、空目录和相同 userData 重启。没有接入 09 候选或 19 SSE，后续任务沿用 scope 失效契约。
- 2026-10-08 中途失败保留：范围组首轮 7 passed / 1 failed，重启的产品断言已通过，夹具在退出后晚取 Playwright `process()` 失败；改为启动时保留 ChildProcess 后单项 1 passed（`artifacts/06-green-restart`，9.6s）。首轮完整源码 65 passed / 1 failed，旧 FIFO 测试的无筛选 `status` 定位器与目录加载提示冲突；把目录加载改为 `aria-live="polite"` 后 FIFO 与具名选择边界 3 passed，最终全量结果见下。原失败上下文均保留，不将中途失败计为通过。
- 2026-10-08 候选验证：激活 Conda `NotAlone`，确认加载本工作树 `backend/src`。`npm run typecheck` 通过；`npm test -- --output=artifacts/06-source-verified` 为 67 passed（3.5m）。`npm run package` 构建实际 arm64 App 并通过 ad-hoc 签名；再运行 `NOTALONE_TEST_APP_EXECUTABLE="$PWD/out/NotAlone-darwin-arm64/NotAlone.app/Contents/MacOS/NotAlone" npx --no-install playwright test tests/contact-*.spec.ts tests/windows.spec.ts tests/setup.spec.ts tests/setup-recovery.spec.ts --output=artifacts/06-packaged-verified`，26 passed（2.1m），其中联系人 11 项。严格 `codesign --verify --deep --strict --verbose=2`、`git diff --check` 通过；已查看包内 `contact-helper.png` 与 `contact-manager.png`，选择、输入和页脚均真实可见，无 force 点击。
- 2026-10-08 数据与收尾：仅本轮随机新建并正式迁移的 `notalone_contact_session_<随机值>_test` 库存放合成 owner、联系人、来源和消息；独立 env/info/userData，模型与 helper 指向本轮受控不可用路径。没有读取私人 dotenv、默认握手、微信或既有剪贴板，没有调用模型或外部发送。候选前核对集成仍为正式基点；任务 06 测试库、临时后端目录及本工作树 App 进程均为 0。产物保留在本工作树 `desktop/artifacts/06-*` 和 `desktop/out/NotAlone-darwin-arm64/NotAlone.app`，不提交。等待主 Agent Standards/Spec 两轴评审，保持 claimed。
- 2026-10-08 初审整理候选：主 Agent 初审 Spec 为 0 项，Standards 为 0 硬违规、1 项 possible Duplicated Code。先合入最新已批准文档 `f79861fd250bd7b457d10df14c6ea1e7f3fb757d`，合并点 `3f94320eceeb75b1fc1583f75c762dffb4871fa6`；然后仅将 `ContactFixture` 两处退出等待抽为 `waitForChildExit`。`stopBackend` 仍先认证 POST 并确认 stopped，`cleanup` 仍只对本轮持有的存活子进程发送 SIGTERM；保留各自安全错误以及 75 次、每次 100ms 的等待边界。`npm run typecheck` 与 `npx --no-install playwright test tests/contact-*.spec.ts --output=artifacts/06-review-fixture-green` 通过（11 passed，49.5s），使用 Conda `NotAlone`、本工作树后端和本轮随机迁移 PG 库，覆盖退出、复用、重启及联系人范围。`git diff --check` 通过，任务 06 库、临时后端目录及本工作树 App 进程均为 0。产品源码、依赖、构建和包内容未修改，沿用原 67 项源码及 26 项签名包证据。保持 claimed，等待最小增量两轴复审。
