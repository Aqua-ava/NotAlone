# 20：本机 App 打包与完整交付验收

Type: task
State: open
Triage: needs-info
Blocked by: 03, 04, 10, 14, 15, 17, 18, 19
Spec: ../spec.md

## 交付行为

交付包含前端和所需完整 helper 的本机 .app，并用合成资料走通首启、导入、生成、复制、同步和退出。

覆盖规格用户故事：48。

## 验收条件

- [ ] 实际 .app 由 Finder 启动，运行不依赖开发服务器或原型；Python/PostgreSQL 仍使用已配置本机环境。
- [ ] 核验完整 helper/动态库、受控路径、签名及权限记录，验收真实快捷键、剪贴板和退出停读。
- [ ] 自动化/相关后端检查及 Standards/Spec 两轴评审通过，记录产物位置、已通过和未验证的集成部分。
- [ ] 模型冒烟使用合成输入，真实微信只在既有明确确认范围验收；不处理未授权私人数据、不发送消息、不推送远端。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 最终实机须包含用户主动选择单联系人 JSONL 的真实系统文件选择器、最终签名包 UI 和调度门禁的正向 App 适配。任务 07 的自动化只控制必要原生对话框 I/O，并已分别记录源码 App 与真实 HTTP/PG 证据；不能据此声称上述三项已验收。当前真实桌面验收仍暂停，只由主 Agent 在用户认可的有限时段协调本项；不新增任务或改动依赖图。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。

- 2026-10-09（依赖阶段静态准备）：15/17已resolved，10/18及原生桌面验收继续待完成。root仅准备CLI构建输入与签名选择源码：新session安全政策加入硬编码Core清单，build_cli.sh默认明确ad-hoc、仅显式签名身份，不扫描私人证书。未执行脚本、构建包、签名或App。现打包仍缺完整可追溯wechat-cli/WCDB输入；用户绝对目录及版本来源请求待答，不能用合成CLI充当正式helper。外置旧probe仍可能沿后台三参数取整窗，最终受控helper须在执行前验证完整可信产物，不能运行未知probe探测能力或回退旧捕获。当前仅静态准备，20保持open、原依赖图不变，不写Answer或勾验收。

- 2026-10-09（上述静态准备验证）：实际命令zsh -n native/macos/scripts/build_cli.sh、git diff --check与二十任务字段/DAG/链接辅助检查均通过，仅解析脚本与仓库文档，没有执行build_cli.sh、codesign或任何原生程序。数据处理范围未增加，不读取聊天、帧、钥匙串或模型凭据；完整包/外置probe可信门禁与最终实机仍待。

- 2026-10-09（当前授权范围收尾）：原集成树停在 `194fab9`，后续源码与记录留在任务10树；已用 `git merge --ff-only d6a3e6ae398f084d794e2eec54f9084cf55f3e72` 无冲突整合到 `codex/mac-desktop-app`，保留工作树及全部历史，未改默认 main、未推送。受影响页面验证共 43/43，其中本次新增执行 23 场、保留等价源 20 场；类型检查、构建、`npm test` 安全调度 24/24、任务字段/DAG/链接检查通过。精确库及清理证据、固定增量双轴报告已保全于 `desktop/artifacts/acceptance-closeout-d6a3e6a`。

  本次执行（均在 Conda NotAlone、真实隔离 HTTP/PG、单 Chrome 范围内）：
  - `npm run test:pages -- --case reply-evidence --case message-events --timeout-seconds 300`：14/14。
  - `npm run test:pages -- --case import-submit-acceptance --case draft-rewrite --timeout-seconds 300`：5/5。
  - `npm run test:pages -- --case candidate-copy --timeout-seconds 300`：4/4。
  - `python /tmp/notalone-app-context.p9MPie/closeout-verify.py`：43 个精确测试库均不存在，页面/清理证据通过；脚本副本随上述本地产物保存。

  用户在本次交接中澄清 CLI/WCDB 完整目录及版本来源“没准备好”，不再视为待答或已备齐。20 保持 open/needs-info，10/18 仍未完成；真实 Electron、签名/打包、系统输入、剪贴板、微信及真实模型继续暂停。后续须先提供完整可追溯 helper 输入并完成18可信定位与20隔离验收准备，再安排具体原生时段。只处理合成资料，未迁移业务库、未访问私人数据、未启用外部 tracing 或发送消息。


- 2026-10-09（后续用户认可的有限桌面时段）：在 `032d70f` 源码树，用户确认长时段后限定 22:58:43–23:58:43（UTC+8）、最多两次启动，仅运行窗口与资料展示各一项。源码 Electron 实际 2/2 通过（9.8 秒），夹具正常清理且预约租约 absent；记录及确切命令见 [有限桌面验收](../../observation-model-smoke/acceptance.md#后续有限桌面验收)。该许可仅覆盖本轮两项，不解除其他任务暂停或扩大微信范围；未运行最终签名包、微信、剪贴板及系统文件选择。任务 20 仍 open/needs-info，完整 helper 与任务 18 等前置条件未因此完成。


- 2026-10-10（真实微信前置梳理）：用户要求先补可直接完成部分。固定4654aec构建桌面arm64 ad-hoc包并通过递归严格签名；仅前端资源，不含wechat-cli/WCDB，因此不是完整交付。同步构建本仓库探针／核心库并校验签名，未运行App或微信。PATH／项目helper配置／默认桌面启动配置均未找到可用CLI入口，只核查既有位置不扫描其他个人目录。完整可追溯CLI/WCDB仍需提供，随后补随包集成。已明确手工确认绑定的CLI同步不依赖OCR，首轮可用隔离库、单联系人和禁用模型的路径；未配置或启用真实同步。详见[前置核查](../../observation-model-smoke/acceptance.md#2026-10-10真实微信验收前置核查与已补齐项)。20保持open/needs-info。

- 2026-10-10（目标模式：重复核查准备）：用户要求继续自主推进并按完成结果优化下一步。将既有完整 helper 输入检查整理为公开 `npm run check:helpers` 接缝；只接受显式绝对目录、版本声明、公开 HTTPS 来源与目标架构，检查固定 CLI/WCDB 和 Mach-O 声明的目录内依赖、文件类型、SHA-256、架构及严格签名。未知来源不试运行，外部依赖/符号链接不自动追读，版本声明不当作实测版本；输出明确静态通过不等于渠道或 App 验收。此工具是原票前置核查的必要实现选择，不决定随包布局或运行时接口、不改依赖图；完整输入缺失，本票保持 `open / needs-info`，不勾原验收项。

  公开 CLI TDD：缺命令 red → 参数拒绝 green；脚本冒充 CLI red → 格式拒绝 green；完整合成 Mach-O 运行时 red → 静态通过 green；动态库改名 CLI 原先错误通过 red → EXECUTE/DYLIB 类型核对 green。6 项具名检查包含缺依赖、越界链接、错误架构、损坏签名和参数/输出脱敏，全部通过。`npm test` 类型及 30/30 安全检查通过（原 24 项 + 6 项），`git diff --check` 通过。只用临时合成 C 文件和自有签名夹具，逐组精确清理；没有运行生成二进制、Electron、微信、探针、数据库、模型或读取私人配置。固定基点 `04404be`，两轴评审及本地提交随后补齐。
