# 07：单联系人历史预览

Type: task
State: resolved
Triage: ready-for-agent
Blocked by: 05, 06
Spec: ../spec.md

## 交付行为

用户主动选文件，查看本人、联系人与资料范围，得到可确认的单联系人导入预览。

覆盖规格用户故事：35、36、37。

## 验收条件

- [x] 文件选择器只读取本次主动选择的文件，预览沿用已有接口并能新建或选择联系人。
- [x] 混合联系人、群聊、损坏及身份冲突明确拒绝，不部分落库，不扫描其他文件。
- [x] 预览保持联系人和文件确认关联；联系人或文件变动后旧预览不能被提交。

## 测试与范围

### 已核对的最小契约补齐

- `POST /api/imports/preview` 保留 `path`，增加可选 `contact_id` 与响应 `content_sha256`。当前运行 owner 由服务端提供；预览只读核对本人渠道身份、撤销历史、其他 owner 的 active 占用，以及所选既有联系人的渠道一致性，不初始化或恢复身份、不创建联系人。
- `POST /api/imports/commit` 增加可选 `expected_content_sha256`，旧调用保持兼容。提交仅读取一次文件，对同一已读文档校验摘要后再规范化并交既有原子事务；摘要不同返回稳定受限错误码，不输出路径或正文。
- 主进程持有系统单文件选择及本次联系人选择。换文件、换联系人或连接失效撤销旧预览和确认；渲染层不接收或提供文件路径。任务 08 只在再次核对连接、联系人范围与选择版本后取出本次确认，失败或取消后不能复用旧确认。

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Answer

已完成单联系人历史预览：主进程仅持有用户本次主动选择的文件，公开后端只读核对本人和联系人渠道身份；用户明确选择既有联系人或新联系人名称后手动确认。混合联系人、群聊、损坏和身份冲突明确拒绝，预览不写联系人或资料。文件、联系人或连接变化使旧预览和确认失效；已为任务 08 提供一次性确认接线，后端提交对同一次已读内容核对摘要再执行原子写入。

主 Agent 对最终代码 `8a5eb347e852f49d6ae8bdb0a945470f6f0eb972` 的增量两轴结论为 Standards hard rule 0／possible smell 0、Spec 0，原 P3 UUID 重复已修复。Spec 确认必要原生对话框 I/O 替代符合原测试决策，已有本任务范围证据支持上述三项验收，因此任务 07 关闭，任务 08 可继续代码与隔离 HTTP 验证。任务 16 状态及其余依赖图不变。

证据按版本分别保留：历史源码 `85512fb15bef4360718bd156acefae1a51e011c8` 完成实际 App 101/101（含预览 14）及真实 HTTP／随机隔离 PG 114/114；最新代码 `8a5eb34` 合入接线并完成等价 UUID 去重，仅相关 types/build 与差异/任务辅助检查通过，未重跑 App。旧签名包来自 `c8711a2b6ed6ba788eaeb1da7463b3fb2c6ab2a5`，仅安全构建和严格签名通过，不能代表最新代码或签名包 UI 验收。主 Agent 已把旧包、21 个历史 test-result 文件和三份日志保存于集成工作树 `desktop/artifacts/07-*`；`07-verification/historical-evidence-manifest.json` 记录版本、hash 和证据限制。源码 App stdout 只保留于历史工具输出及 Comments，`.last-run.json` 不能独立证明 101 项数量；错误模块命令不计通过，mypy 仍未通过。

真实系统文件选择器、最终签名包 UI 与调度门禁正向 App 验收继续保留在[任务 20](20-mac-app-delivery.md#测试与范围)，由主 Agent 按用户安排协调；本次只收束文档、检查差异与二十任务字段/DAG/链接，不启动 App、后端或打包。历史随机库、进程、配置、握手及 userData 已回收，保留的合成证据与构建产物均被忽略，不写业务数据、不访问私人资料、不 push 或创建 PR。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。
- 2026-10-08：开始任务 07。核对现有接口后，按已经批准的身份冲突及预览失效验收明确上述兼容增量；不增加来源副本、持久 token 表、身份恢复、目录扫描或任务 08 的进度页面。候选完成后由主 Agent 统一进行两轴评审。
- 2026-10-08（历史 red → green）：实际 App 的初始文件选择按钮仍禁用、导航返回时新联系人名称丢失、主动取消确认入口缺失先分别失败，修复后通过。真实 HTTP／PG 中，本人 active 冲突、撤销身份、其他 owner 占用、所选联系人渠道冲突和群聊原先错误返回 200；预览后改变文件的旧摘要提交原先错误写入 6 条合成消息，修复后为 `409 / import_file_changed`、零联系人，重新预览的新摘要才可原子写入。所有 red 的合成库均已回收。
- 2026-10-08（历史最终源码验证）：在本工作树 `desktop/` 激活 Conda `NotAlone` 后执行 `npm run typecheck && npm test`，当时 `npm test` 尚是构建并运行真实 App 的旧入口；最终 101/101、7.1 分钟、exit 0，包含本任务 14 项预览行为。暂停指令到达后立即发送 Ctrl+C，返回时整组已自然完成，未再启动 App。**此为门禁引入前的历史命令和结果，不是当前重跑指令**；现在 `npm test` 仅安全检查，真实 App 只能由主 Agent 在用户认可的时段经新受限入口安排。
- 2026-10-08（历史测试范围）：14 项使用真实窗口的公开选择、预览、核对、取消、换文件和换联系人操作，以及当前工作树真实后端 HTTP／随机迁移 `_test` PostgreSQL 库。仅 `dialog.showOpenDialog` 的系统 I/O 返回使用必要夹具，不替换解析、身份校验或持久化业务；范围失效的延迟只安排真实 HTTP 传输。非法路径/目录外 ID 和在途请求通过具名公开桥接验证，不读 React 私有状态。确认后无联系人写入，渲染层不取得完整路径、摘要或正文。**尚未操作真实系统文件选择器，尚未运行本任务签名包 UI**，不能把上述夹具自动化称为 native dialog 实机通过。
- 2026-10-08（历史最终后端验证）：从本工作树根执行下列命令，临时 runner 隔离 dotenv、env/info、owner、模型及 CLI/探针，先创建本轮随机 `_test` 库并运行正式迁移，最后仅删除该库。实际模块来源核对为本工作树 `backend/src`；最终 114/114、39.605 秒、exit 0。现有核心流程的连接关闭出现 `ConnectionResetError` stderr，整组仍为 `OK`，不将它记作新的业务失败或静态检查通过。

  ```bash
  source /Users/local-user/miniconda3/etc/profile.d/conda.sh
  conda activate NotAlone
  PYTHONPATH="$PWD/backend/src:$PWD/backend" python /tmp/notalone-07-http-test.py \
    tests.unit.ingest.test_models tests.unit.ingest.test_jsonl_reader \
    tests.unit.ingest.test_validator tests.unit.ingest.test_preview \
    tests.unit.ingest.test_normalizer tests.unit.ingest.test_import_command \
    tests.unit.application.test_import_service \
    tests.integration.server.test_import_task_api \
    tests.integration.server.test_first_import_api \
    tests.integration.persistence.test_postgres_repository \
    tests.integration.server.test_import_auto_flow \
    tests.integration.server.test_core_business_flow
  ```

- 2026-10-08（未计通过的命令）：前一次合并测试命令错用了不存在的 `tests.unit.ingest.test_export_boundary`、`tests.integration.application.test_import_auto_flow`、`tests.integration.test_core_business_flow`，有三项模块导入错误，exit 1；该结果不计入 114 项通过。修正模块名后才运行上面的最终命令。四个改动源文件的 `mypy --follow-imports=silent` 当前 67 项错误，固定基线 `beda065` 为 68 项；去掉行号对照无新增、少一项，但 **mypy 未通过**，既有类型欠账仍保留。
- 2026-10-09（安全恢复与合入）：用户选择“先继续不触桌面的工作，实机验收稍后安排”。先只读核对本任务 Electron/后端/runner 进程为零，并核对两个已知本轮随机库已不存在；原 App 全组 fixture 与 Python runner 已正常清理隔离库、配置、握手和 userData。合入当前集成 `ef86567`，仅桌面说明/权限台账文档冲突，保留双方真实记录、07 接线和受限新入口；07 所有仓库内 App 用例均经 `contact-fixture → app-fixture → launchApp`，无独立启动。临时 native-dialog 脚本只曾准备、从未执行，本轮亦不使用。未重复 App/Playwright、键盘、CUA 或私人数据验收。
- 2026-10-09（不触桌面的产物验证）：合入后的 `npm run typecheck`、`npm run package`（包含 build）和 `codesign --verify --deep --strict --verbose=2` 通过。只生成/签名，未启动 `.app`；实际 `com.notalone.desktop`、ad-hoc、仅 `allow-jit`、ATS 任意传输为 false，无相机/麦克风/蓝牙用途说明，未查询私人证书或修改 TCC。产物为本工作树 `desktop/out/NotAlone-darwin-arm64/NotAlone.app`；`Contents/Resources/app.asar` SHA-256 为 `1e93b1080113bfef9b31ac426cbeca36528dd616c182fadf911b498dd2c0a16a`。打包器提示没有可选 `.icon` 格式，`.icns` 与严格签名生成成功；不把这个警告视为 App 启动验收。
- 2026-10-09（待评审/待实机）：候选保持 `claimed`，不写 Answer、不更改依赖图或承诺关闭任务。文件选择器的必要系统 I/O 自动化与真实 native dialog 明确分开；签名包 UI、真实系统文件选择器和调度门禁的正向 App 适配仍待主 Agent 按用户决定安排，最终实机项记录于任务 20。本任务勾选及 resolved 由主 Agent 两轴结论据实判定。`desktop/node_modules/`、`dist/`、`out/`、`artifacts/`、`test-results/` 与临时安全日志均未提交；没有业务库迁移、目录扫描、模型/微信调用、外部发送、push 或 PR。
- 2026-10-09（完整双轴与本轮修复）：主 Agent 对 `a290b13` 完成完整评审：Spec 0；Standards hard rule 0、possible smell 1（P3，导入/联系人三处 UUID 正则与小写归一化重复）。Spec 确认原测试决策允许必要系统对话框 I/O 替代，历史源码 App 101/预览 14 与真实 HTTP/PG 114 项足够本任务范围；真实 native dialog 与签名包 UI 留在任务 20。采纳维护建议前先合当前集成 `136a5ba`，保留导入和绑定授权两条接线、HTTP 传输夹具的两种延迟条件及双方真实台账；合入后的修复基点为 `e06e14a5d9e1b7e22d8aae7a8c3a08a7a8f25c8b`。
- 2026-10-09（UUID 去重，待增量复核）：主进程新增 `uuid.ts` 纯值函数，集中原 ASCII 正则与小写归一化，导入桥接、联系人桥接及联系人目录复用；绑定校验仅复用同一格式 predicate，locator 的独立纯规则不变。未增加 trim、UUID 版本限制或新接受格式；各处结构、参数、sender、联系人/owner 范围检查与固定中文错误仍由各信任边界保留。修复后仅 `npm run typecheck && npm run build`、差异及二十任务字段/DAG/链接辅助检查通过；没有镜像正则单测、App/Playwright/CUA、后端全组或重新打包。原签名包对应 `c8711a2b6ed6ba788eaeb1da7463b3fb2c6ab2a5`（`a290b13` 仅文档），历史 asar hash 不变，**不代表已合绑定授权及 UUID 修复后的最新版**。任务仍 `claimed`，不写 Answer，待主 Agent 增量两轴确认后判定关闭与解阻 08；不改变任务 16 的 claimed 或 17/18 阻塞。
- 2026-10-09（最终 Standards）：主 Agent 对 `8a5eb347e852f49d6ae8bdb0a945470f6f0eb972` 增量复核为 hard rule 0、possible smell 0；原 P3 UUID 重复已修复。合入后的七处接线与规则等价无剩余问题，各信任边界仍分别核对参数结构、来源和范围。
- 2026-10-09（最终 Spec）：主 Agent 增量复核为 Spec 0，确认原规格允许必要系统对话框 I/O 替代，历史实际 App 101/预览 14 与 HTTP/PG 114 项足够任务 07 关闭并解阻 08 的代码及隔离 HTTP 工作。三项验收据实勾选、写入 Answer 并改为 `resolved`；真实 native dialog、最终签名包 UI 和门禁正向 App 验收留在任务 20，不改依赖图或其他任务状态。
- 2026-10-09（文档收束）：仅更新任务结果与同义权限台账，明确最新代码 `8a5eb34`、历史源码 App `85512fb` 和旧包 `c8711a2` 的版本边界；只读核对主 Agent 保存的历史 manifest，未覆盖旧包、截图或日志。收束验证为 `git diff --check` 和 `node /tmp/notalone-app-context.p9MPie/validate-tickets.mjs`；没有 App/GUI、键盘、原生对话框、新后端、重新打包或远端操作。
