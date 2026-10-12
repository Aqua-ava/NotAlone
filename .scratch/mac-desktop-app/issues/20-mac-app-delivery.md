# 20：本机 App 打包与完整交付验收

Type: task
State: claimed
Triage: needs-info
Blocked by: 03, 04, 10, 14, 15, 17, 18, 19
Spec: ../spec.md

## 交付行为

交付包含前端和所需完整 helper 的本机 .app，并用合成资料走通首启、导入、生成、复制、同步和退出。

覆盖规格用户故事：48。

## 验收条件

- [x] 实际 .app 由 Finder 启动，运行不依赖开发服务器或原型；Python/PostgreSQL 仍使用已配置本机环境。
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

- 2026-10-12（用户要求最终签名包／Finder收尾）：新增功能冻结，OCR继续暂停；用户明确要求本轮连续完成、无需反复授权。限定实际启动在10:40–11:00、最多6次，仅合成资料与随机测试库。基点`b6fed39f`的当前源码离线重建本机arm64 ad-hoc包，采用此前核验的官方CLI 1.6.25原字节及仓库探针；新包递归严格验签与随包哈希通过。包内持续会话生命周期实际1／1、14.4秒（runner14.7秒）／exit0、两次启动，完整关闭／退出／重开／显式重试通过。Finder实机仍待，其他缺项及原四条验收保持。

  必要验收接缝补充为主Agent的Finder桌面打开 → 最终包 → 配置的绝对Python → 真实隔离PG：只在有限`test:app`活租约内计入一次外部启动，由CUA执行真实Finder打开及App公开控件；不以`open`命令代签Finder。默认userData若已有资料，只核验目录元数据并整体暂存，不读取内部文件，再在默认位置创建自有空测试目录；App／后端正常退场后按dev/ino恢复原目录。目录被替换、App未退场或恢复不确定时保留原备份／测试库／租约，不删除或终止未知资源。两项纯合成隔离保护检查实际先缺入口red，再green，完整类型通过。两轴初评各发现同一P2：查询异常／缺握手不能证明后端退场；已改为signal0仅ESRCH证明退出，放行Finder却未取得backendPid时一律保留现场，复审两轴0。新增内容只在测试夹具，不增加产品功能、权限或渠道读取。

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

- 2026-10-10（静态核查两轴修复）：初版固定提交 `85f42784de74f37206e85fb172a0b71a94d10759`，Standards 硬违规/可选建议均 0；Spec 发现 P1：外部或未知 RPATH 被跳过，有内部副本时可能错误静态通过。公开 CLI 合成回归先复现错误退出 0，再改为保守拒绝外部/未知搜索候选；搜索候选的符号链接同样不跳过，不读外部正文。新增真实 Mach-O 搜索顺序两场（首个外部路径/未知前缀，随后内部路径），7 项核查组通过；最终安全组与增量复核随后补齐。本票完整输入与现场条件仍缺，不提前关闭。

  修复后最终 `npm test` 的类型检查和 31/31 安全检查通过（24 项调度 + 7 项静态核查）。未因文档维护重跑模型、数据库、普通页面或原生 App；继续只构建/签名自有合成 C 文件，生成二进制未执行，精确临时目录正常清理。

- 2026-10-10（静态准备评审收口）：固定增量 `85f42784de74f37206e85fb172a0b71a94d10759 → 6a3efcdfad0412d8c989be2ddc111b2fcf355db3` 独立 Standards 硬违规/判断建议 0/0，Spec 新问题 0，原 RPATH P1 已关闭。评审只读，不新增执行。此结论仅关闭核查工具的实现与修复；完整真实输入、随包接线及最终原生验收仍缺，本票继续 open/needs-info，原依赖和验收条件保留。

- 2026-10-10（用户要求继续：随包接线切片）：重新核对后，正式输入缺失不阻止用合成 Mach-O 实现 CLI/WCDB 的受控搬运和默认启动路径。继续本票内的必要实现：公开 `prepare:helpers` 只拷贝静态核查通过的固定文件/声明依赖，保留相对布局、哈希及未核验版本/来源声明，搬运后复核；`package` 仅在显式目录/版本/来源参数齐备时纳入 `Contents/Resources/notalone-helpers`，不扫描 PATH 或用户目录。Finder 启动在没有明确配置时使用包内已核验 CLI；显式配置保持优先，包内文件缺失/变化时不可用，不加载未知探针。本片不自动安装 helper、不修改绑定/开关、探针参数政策、权限或数据 schema；只完成 CLI 侧接线，完整探针及最终包仍按原条件验收。测试接缝是公开准备 CLI 与现有启动诊断 `getPaths`/后端启动环境，只在 Node 和自有合成文件运行，不启动 App/Python/微信。Context7 不可用，已核对官方 Packager extraResource、Electron resourcesPath/isPackaged 与安装版本 20.3.0/44.7.0；签名跳过已核验输入以保留原二进制，不注入 Electron JIT entitlement，主包签名和最终严格核查保留。先逐片 red → green，不新增任务或关闭本票。

  准备命令不存在时实际 red（退出 1 而非 0），实现后同一公开场景 green；启动诊断原先返回空 CLI 路径形成第二个 red，最小默认值接线后 green。覆盖源目录移除后仍可取得包内 CLI、字节变化、缺库/越界链接/重复清单停用、显式配置优先；搬运拒绝已有目标和不能迁移的绝对依赖，失败后自有半成品清理、已有文件保留。绝对依赖夹具初次用 install_name_tool 修改失败，不算产品 red；改为链接时声明真实绝对依赖后完成实际拒绝检查。`npm run typecheck`、`npm run build`、Node 三个脚本语法检查与 `git diff --check` 通过；最终 `npm test` 35/35（24 项调度、11 项 helper/启动配置）通过。未生成含 helper 的 App 或运行实际 Packager 拷贝/签名，不能称新签名策略已实测；没有启动 Electron、Python、数据库、微信、探针或执行合成二进制。仅自有 Node/C 临时文件，逐场精确清理；固定基点 d242562，两轴评审随后补齐。

- 2026-10-10（随包接线评审修复）：固定 `d242562 → 4cdbf7e`，Standards 硬违规 0、P3 重复文件集合比较建议 1；Spec P1 发现默认 CLI 经设置表单保存后被当作显式路径，短路后续完整性核验。沿公开 `getPaths → savePaths → 修改 CLI/删除库 → getPaths/启动环境` 复现实际 red；路径解析改为识别当前包内 helper 命名空间，保存值及环境值指向该组时仍核验全部文件，损坏时返回未配置路径，同场 green。外部显式路径优先不变，未执行输入或启动 Python。合并搬运、Packager 拷贝、最终包三处文件集合/哈希比较，保留各阶段检查。`npm run typecheck`、脚本语法、`git diff --check` 和最终 `npm test` 35/35 通过；增量两轴复核随后补齐。完整输入、实际 Packager 和最终原生验收仍缺，不关闭原票。

- 2026-10-10（继续仓库探针侧）：CLI 增量 `4cdbf7e → 5f1cf47` Standards 硬违规/建议 0/0、Spec 新问题 0，原 P1 关闭。继续本票的探针随包实现：公开 `prepare:probe` 只从仓库固定 7 份 Swift 源码和构建脚本创建自有快照，显式 ad-hoc 静态构建、记录来源摘要，逐文件核查与搬运；不接受外部探针目录，不运行生成 CLI、权限检查或采集。`package --with-probe` 才将此组纳入独立 `notalone-probe` 资源目录并复核；仅包内默认及指向它的配置沿现有启动路径接缝核验，外部配置保留既有优先级。`--session` 的未知布局失败关闭与后端参数不变，不扩展采集或现场授权。测试接缝为公开准备命令、`getPaths/savePaths` 和启动环境，实际 Swift 仅编译/签名，不执行；先 red → green，原票完整渠道输入及最终 App 仍待。

  公开准备入口缺失形成实际 red（退出 1），实现仓库快照构建和静态搬运后该部分 green；同一公开链路的启动诊断原先仍返回空探针，形成第二个 red，接入共享包内路径核验后完整场景 green。保存后损坏核心库时返回未配置路径；环境值指向损坏组同样拒绝，恢复文件后重新可用，外部显式配置保持优先。已有目标和外部输入拒绝，重复打包开关在图标/打包/编译前拒绝；未执行 Packager 生成新包，不能称其新 hook 或签名策略已实测。`npm test` 类型与 37/37 安全检查、`npm run build`、Node 脚本语法、`zsh -n` 与 `git diff --check` 通过。只编译/签名仓库 Swift 与自有合成 C 文件，临时源码、模块缓存和产物精确清理，未运行任何生成二进制、App、Python、数据库、微信或模型。固定基点 5f1cf47，两轴评审随后补齐；本票仍 open/needs-info。

- 2026-10-10（探针构建评审修复）：固定 `5f1cf47 → 30e634c`，Standards 硬违规 P1 1、可选建议 0，Spec P1 1，均指向构建 zsh 仍可能读取用户 `.zshenv`；前版清空环境不能证明未继承启动配置。将本票测试接缝补到必要的 shell 进程适配边界：生产构建调用共用 `repositoryBuildInvocation`，用本轮合成脚本/`.zshenv` 实际调用系统 zsh，red 阶段显式把配置目录指向自有目录，不接触真实个人文件；哨兵原先被执行形成实际 red。加 `-f` 和自有 `ZDOTDIR` 后同场 green，签名身份和模块缓存保持本轮固定值；不修改 HOME。完整安全组及增量两轴复核随后补齐。未改变探针参数政策、数据范围或现场验收条件。

  修复后 `npm test` 类型与 38/38 安全检查通过（24 项调度 + 14 项 helper/启动配置），包括实际仓库 Swift 重新构建/签名/搬运与 shell 哨兵拒绝。`node --check desktop/scripts/prepare-probe.mjs`、`git diff --check` 通过；未因构建工具修复重跑 App、普通页面、数据库或模型，临时夹具和编译缓存正常精确清理。

- 2026-10-10（本轮实现评审收口）：固定增量 `30e634c → a197b38` Standards 硬违规/建议 0/0、Spec 新问题 0，原 shell P1 两轴均关闭。CLI 保存路径 P1 在先前 `4cdbf7e → 5f1cf47` 已关闭；本轮两组构建/搬运/默认路径实现及修复完成。只读评审不新增运行。原票仍 `open / needs-info`：真实完整 CLI/WCDB 与来源、实际 Packager 及新最终包、Finder/权限/复制/微信等现场证据和 10/18 依赖尚缺，不勾原验收项。总清单据此调整下一步，不自动安装 CLI，不扩大用户已确认的数据或桌面范围。

- 2026-10-10（目标续跑：离线构建验证）：复核当前源码，Packager 拷贝 hook/签名保留仍只有静态证据，但可以在自有目录用合成 CLI 和仓库探针验证构建，不需要现场或正式 CLI。继续原票公开 `package` 命令接缝：增加显式离线 Electron ZIP 目录和不存在的输出目录，避免联网、覆盖历史产物或启动 App；沿生产 Packager 实际复制两组文件、签名及严格核查，再从实际包 Resources 调用现有 Node 启动诊断/环境。检查包使用当前编译资源和合成 CLI，不作为正式渠道交付，不操作 Finder/权限/微信/剪贴板。显式 `test:package` 只构建检查包，普通 `npm test` 继续排除 App 包构建；先公开命令 red → green，原依赖与现场验收保留。Context7 无可用工具，已核对 Packager 官方 electronZipDir/out 约定及安装 20.3.0 源码：指定 ZIP 目录时不进入下载分支，缺档直接拒绝。

  实际公开打包命令先因新参数未支持退出 1，形成 red；接入独立输出/离线 ZIP 后第一次实际构建因夹具归档带入 AppleDouble 元数据导致 framework 严格签名失败，改为 `ditto --norsrc` 修正自有 ZIP，未修改签名规则或已安装 Electron。最终 `npm run test:package` 1/1 通过（23.943s）：真实 Packager 复制两组、原 CLI 字节保留、manifest 哈希、各文件与主包严格签名、helper 无 JIT entitlement、实际包 Resources 下 Node 路径及环境均通过，且已有输出拒绝/保留、缺档失败后自有输出清理。生成包和输入从未执行，临时包/ZIP/编译缓存精确清理，没有访问数据库、微信、模型、TCC 或系统输入。

  曾用名称过滤排除构建用例但实测未生效，导致默认组也构建检查包并通过 39 项；该轮不算默认无构建证据。评审阶段将构建用例移至独立 `tests/packaging/command.test.mjs`、共享合成 C 夹具，默认入口恢复固定安全文件列表。最终 `npm test` 类型及 38/38 通过（8.634s），输出中无构建用例；脚本语法、`git diff --check` 通过。仅构建工具/测试接线变化，不重跑已通过的页面、真实 App 或后端业务；固定基点 ea317cf，双轴评审随后补齐。本票完整真实输入与现场依赖仍缺，保持 open/needs-info。

- 2026-10-10（离线构建评审收口）：固定增量 `ea317cf → 5d980fc` 独立 Standards 硬违规/建议 0/0、Spec 新问题 0。两轴确认独立输出的独占创建/身份核对清理、离线固定版本归档检查、两组搬运/最终核查及默认测试与显式构建测试的隔离符合原范围；只读评审未新增执行。实际合成包构建已有证据，剩余条件优化为正式 CLI/WCDB 来源与输入、正式输入包、10/18 依赖及有限时段下的 Finder/权限/复制/微信等原生验收。本票继续 `open / needs-info`，四项原验收不勾选；总清单同步本轮证据与下一步，不扩展数据、外部调用、桌面或远端 Git 授权。

- 2026-10-10（用户授权自行查找输入）：用户明确答复“你可以直接找下吧”。从仓库记录的维护者查到当前官方源码 `r266-tech/wx-cli` 与其指向的发行仓库 `r266-tech/wechat-cli-releases`；旧仓返回 451，当前发行仓库无历史 v1.6.20，采用其非预发布 v1.6.25 作为待验证输入，不迁移至 v2 RC。已下载固定 arm64 ZIP、checksum、manifest，三者匹配 GitHub API 摘要，CLI/WCDB 字节及组件 SHA-256 匹配，公开静态核查通过。只从归档提取必需二进制与许可证/说明，未执行安装器、wxkey、CLI 或初始化，不读取私人资料；WCDB 版本及构建时间在上游 manifest 中为 unknown，来源与运行可用性仍分开记录。

  核对旧依赖修复票 09 与现行启动配置时，发现包内 CLI 未显式固定 WCDB 库，且整份环境继承可能保留指向外部库的覆盖。继续原票受控启动接缝的必要兼容修复：测试沿既有公开 `loadBackendConfiguration → backendEnvironment` 和 Node `getPaths/savePaths`，合成环境只声明自有外部库路径，验证包内选择固定已核验库、损坏组停用且不保留覆盖、外部显式 CLI 仍保持其配置优先。先 red → green；不运行任何 CLI/库，不改变绑定、权限或后端领域接口。随后用取得的固定发行输入离线重建候选 App，只构建/签名/静态检查，最终原生/微信及原依赖仍未完成。

  实际公开 Node 场景先因 `WECHAT_CLI_WCDB_LIB` 为 undefined 而失败；整组解析同时返回受控库位置后同场通过。进一步合成检查四个覆盖清理、保存后仍固定库、损坏后无覆盖及外部配置优先，直接通过；没有把后续断言写成未运行的 red。最终 `npm test` 类型及 38/38 通过（13.134s）、`npm run build` 通过。实际生产打包命令使用固定输入与 `--with-probe`、独立输出、已安装 Electron 构造的离线 ZIP，通过签名及随包复核；在实际 Resources 下运行 Node 检查，四文件哈希/严格签名、主包 deep strict、原 CLI/WCDB 的上游组件哈希、包内路径及四个库覆盖隔离均通过。

  候选产物为 `desktop/artifacts/helper-upstream-20261010.onrvwc/packaged/NotAlone-darwin-arm64/NotAlone.app`；`candidate-verification.json`、`download-verification.json`、原 ZIP/checksum/manifest 与 `package.log` 同目录保留。发行包所附 CLI LICENSE 和 THIRD_PARTY_NOTICES 保留在候选 `.app` 同级目录；稳定包未提供完整 WCDB 版本/许可集合，不宣称重新分发材料完整。仅这次任务自有忽略产物保留供后续有限验收，不覆盖现有 App；临时 Node 检查目录与离线 Electron ZIP 已精确清理。未执行下载二进制、wxkey、安装器或 App，不初始化、读取聊天、改密钥/Keychain/TCC，也未调用模型。CLI 版本迁移的只读/事件契约、WCDB 精确来源、10/18 与现场验收继续待；本票仍 open/needs-info，四项验收不勾选。固定基点 a7bb6a0，双轴评审随后补齐。

- 2026-10-10（官方输入与库环境修复评审收口）：固定 `a7bb6a0 → c48d59b`，独立 Standards 硬违规/建议 0/0、Spec 新问题 0。两轴确认仅已核验包内组返回 WCDB 路径，失效组仍触发覆盖清理，外置显式配置保持原环境；沿用旧票 09 的库注入要求，未以候选构建替代运行冒烟。只读评审未新增执行。49 条本地文档链接、总清单 8/3/4 分类、原票 open/needs-info 与四项未勾核对、`git diff --check` 通过。本票继续未完成，稳定版契约/WCDB 来源、10/18 和现场证据保留；只做本地提交，不上传二进制或私密数据。

- 2026-10-10（继续稳定输入契约与 WCDB 来源核对）：用户要求无需人在场先推进，真实微信/原生继续暂放。稳定 CLI 的 Go build info 与发行 commit 一致；WCDB 的 LC_ID 为 2.1.15，SQLite/SQLCipher 字符串与腾讯固定源码吻合，但官方资产只含源码而无对应 WCDB 二进制，且库的版本函数为 Custom build，不把线索升格为可复现来源。取得官方源归档并核对 API 摘要，定向保留许可及版本材料；稳定 ZIP 的 README、llms.txt、manifest 生成脚本按声明哈希核对。旧源码有限公开路径仍不可取得，不采用 v2 RC 补证。

  在自有目录先验证 OS 默认拒绝的五项边界：目录外读写、网络、其他程序执行、Keychain 服务查找均被拒绝；初始 `/bin/cat` 被 dyld 拒绝启动，核对本机 Apple `dyld-support.sb` 后只补齐加载规则，合成 canary 全部通过。随后该隔离内执行稳定 CLI 的 version/tools/schema/help 元数据命令，版本 1.6.25、38 项 schema 与 tail 参数声明返回；未执行 App/安装器/wxkey 或读取真实微信。合成 tail 数据调用因环境未定义 HOME 返回失败，不能记为数据读取/纯只读初始化已验证，不修改或重定向 HOME。

  同字节 schema 确认 `read_events` 的 `include_media_paths` 默认 true；当前 v1 文字同步不能依赖严格只读来代替关闭媒体补齐。继续受控参数修复：沿既有 `LocalWechatCli` 的 CommandRunner/FollowProcessRunner 公开接缝，逐个 red → green 固定一次性 tail、单会话 follow、全局 sessions follow 的 `--include-media-paths false`；不按文字类型过滤而丢失非文字计数/游标，不扩展接口或新建任务。稳定版元数据只证明参数声明，缺配置的失败不证明实际消息行为；不支持参数的外置版本按现有命令错误失败，不能静默退回媒体默认。原票四项验收及原依赖仍待。

  实际三个公开命令断言分别因缺少关闭参数 red，再各自 green；baseline/cursor 的已有命令断言同步更新后直接通过。Conda `NotAlone` 内运行 `python -m unittest tests.unit.wechat_cli.test_adapter tests.unit.wechat_cli.test_global_session_stream tests.unit.wechat_cli.test_normalizer tests.unit.front_sync.test_cli_background_sync -v`，75/75 通过，包括非文字计数/水位、全局只投影定位信息、已确认范围、关闭/恢复与失败降级；`git diff --check` 通过。只处理公开资料和合成数据，未连接数据库、外部模型或真实微信；没有重跑已通过的桌面构建组。固定本轮基点 `7b46360`，Standards/Spec 复核待补。

  原始证据保留于 `desktop/artifacts/helper-provenance-20261010.GT1GQm/`：腾讯官方 `wcdb-2.1.15.zip` 为 83197863 bytes，SHA-256 `5b7294459f7f8b85ce373fcd5f3d7a3c004743feb9d51d3c39096a0815834c56` 匹配发行 API；`download-verification.json` 记录首次超时及断点续传结果，`provenance-evidence.json` 记录 CLI/库静态证据、9 份定向材料哈希和执行边界。`sandbox-boundaries.json`、四份 stable 元数据 JSON 与两个失败 tail JSON 保留；临时 canary 可执行文件及合成读写夹具精确清理，保留 canary 源码/profile 供复核。研究笔记与目录在忽略的 `research/` 同步，不强行提交。

  本轮有限官方路径已核对：维护者现行新仓历史从 v2 开始、精确稳定 commit 不可取、发行 tag 只有 README、Go 官方 proxy/checksum 同版本查询失败。下一步条件是取得绑定原字节的稳定 CLI 源码和 WCDB 构建/许可材料，或在明确范围内补初始化/实际事件/游标/JSONL 警告证据；不以重复下载同一源码归档、RC 源码或普通页面代替。需要人在场的真实渠道、Finder/文件选择/快捷键/剪贴板/退出与 10/18 依赖继续暂放；本票仍 `open / needs-info`，四项验收不勾选。

- 2026-10-10（稳定来源补查与媒体参数修复收口）：固定 `7b46360 → 65cfe8f` 的独立 Standards 硬违规/判断建议 0/0，Spec 新问题 0；两轴确认三个入口沿既有进程接缝关闭媒体补齐、保留非文字计数及水位，且文档没有把 schema/HOME 失败/版本线索记为渠道或精确构建验收。两轴只读未新增运行。147 条本地链接、总清单 8/3/4 分类、本票 open/needs-info 与四项未勾、夹具精确清理及 `git diff --check` 通过。评审副本保留在上述自有忽略目录的 `review-results.json`；来源缺口和现场条件保持，只做本地提交。

- 2026-10-10（用户要求继续：签名临时文件清理）：核对上一轮自有候选构建目录，发现 250 个 `tmp-entitlements-*` 残留，不能按此前“临时检查目录已清理”推导签名材料也全部清理。安装的 `@electron/osx-sign 2.7.1` 与官方类型/源码均确认：entitlements 数组会为每个签名文件创建系统临时目录；路径参数可复用已有 plist。继续原票公开 `package` 命令与既有 `test:package` 接缝，以一次 red → green 验证命令返回后本轮临时文件清空、调用者既有文件保留、App 仍只含 allow-jit 且 helper 不获该权限；不增加参数、权限或来源声明，不运行 App/CLI/探针、数据库或模型。旧候选保持原字节，旧残留只在逐项核验自有普通 plist 后精确清理；本票四项验收和依赖不变。

  沿已约定公开 CLI 接缝，给打包子进程单独的自有 TMPDIR，并预置不应删除的目录/哨兵；命令成功返回后的残留断言实际 red（250 !== 0，27.231s）。改为 staging 内单份 plist 路径后，同一 `npm run test:package` 1/1 green（26.095s）：本轮临时文件为 0、哨兵保留、主 App entitlement 精确等于 `{allow-jit: true}`，两组 helper 哈希/严格签名/无 JIT 与 Node 包内路径通过；占用输出保留和缺离线归档失败清理仍通过。主 App 及生成 helper 从未执行，临时检查包/ZIP/编译缓存随夹具 finally 清理。未覆盖旧候选包，不需要因这次构建清理改动重建已保留的官方候选。

  Context7 不可用，已对照[官方类型](https://github.com/electron/osx-sign/blob/main/src/types.ts)与[签名实现](https://github.com/electron/osx-sign/blob/main/src/sign.ts)，再核对安装的 2.7.1 类型和数组转临时文件路径源码。旧残留先记录每个自有目录 dev/ino、文件集合与 SHA-256（250 份均为同一仅 allow-jit plist），再次核对后逐文件 unlink、逐目录 rmdir，不用全局或递归删除；旧候选四运行时哈希未变。证据保留在 `desktop/artifacts/package-cleanup-20261010.Tp699L/` 的 `red-result.json`、`green-result.json`、`previous-residue-inventory.json` 和 `previous-residue-cleanup.json`；固定本轮基点 `e23812f`，最终安全组及独立双轴复核随后补齐。

  最终 `npm test` 类型检查和默认 38/38 安全组通过（10.457s），该命令未构建 App；显式构建验证仍只记为 `test:package` 1/1。`git diff --check` 通过；没有为打包脚本改动重跑不相关的 Python/数据库/模型或原生组。安全组日志 `safe-result.json` 保存在同一自有目录。只处理公开编译资源、仓库源码和合成资料，未增加权限、读取范围、外部模型或远端 Git 操作。

- 2026-10-10（签名临时文件修复收口）：固定 `e23812f → 9f77aa3` 独立 Standards 硬违规/判断建议 0/0，Spec 新问题 0。两轴确认 staging 内 plist 内容和权限不变、现有 finally 清理、公共命令接缝与证据一致，没有新增执行能力或把构建当作现场验收。评审只读未新增运行，结果副本保存于本轮自有忽略目录的 `review-results.json`。4 份改动文档的 56 条本地链接、原票 open/needs-info 与四项未勾、总清单 8/3/4 分类及 `git diff --check` 通过。下一步仍按精确上游材料、有限现场时段、模型预算或资源关联条件推进；不重复已通过构建或新增无需求工具。

- 2026-10-10（本次有限复制／调度时段）：任务 10 在源码 App 中完成真实系统剪贴板与输入小窗隐藏／恢复；本票保留的官方输入候选 App 首次以独立配置通过统一 test:app 启动，管理窗口就绪后按短预约到期收尾，runner 预期退出 124、自有 PID/userData 回收、租约 absent。该路径不是 Finder 启动，后端未连接、CLI／探针不可用；没有初始化或运行微信渠道，不构成完整包复制、文件选择、快捷键、权限或产品停读验收。任务 10 已收口，任务 18 及本票来源／数据／最终系统验收继续未完成；State 保持 open/needs-info，四项原验收不勾选。证据见 `desktop/artifacts/native-copy-scheduling-20261010-1500/`。

- 2026-10-10（第二次有限现场：签名包原生能力补验）：用户“现在就可以”授权当前现场后，明确 15:23–15:43（UTC+8）、最多两次启动。保留的官方输入候选包实际完成 `candidate-copy.spec.ts` 1/1（5.8 秒）与 `native-desktop-acceptance.spec.ts` 1/1（3.8 分钟），总 2/2、runner 退出 0；后者沿既有 App/HTTP 公共接缝使用生产系统文件选择器，选择本轮单联系人合成 JSONL，真实隔离 HTTP/PG 完成 6 条消息及全部导入任务核验。外部模型由本地合成模型替换，不能据此宣称语义质量达标。新增验收场景仅显式 flag 启用，默认全量跳过，不调用快捷键回调或替换对话框。

  用户物理 `Command+Shift+Y` 第一次唤起并确认“小窗出现了”；程序观察第二次阶段同一窗口隐藏、仍为两个窗口，随即正常菜单退出。用户反馈“不行了，现在小窗都不能呼出来了”，与 15:30:34 的退场核查及当前 PID 不存在的记录相符；这是时序解释，不把程序状态写成人工认可隐藏体验。测试原先未提前说明确认隐藏后会退出，现只补明确提示，未因提示修改重跑真实 App。启动额度已全部用完；快捷键退出后注销，现场隐藏体验仍待下轮确认。

  实际命令（Conda `NotAlone`，`desktop/` 下）：`NOTALONE_NATIVE_DESKTOP_ACCEPTANCE=1 NOTALONE_TEST_APP_EXECUTABLE=/Users/local-user/learn/NotAlone/desktop/artifacts/helper-upstream-20261010.onrvwc/packaged/NotAlone-darwin-arm64/NotAlone.app/Contents/MacOS/NotAlone npm run test:app -- --interactive --coordinator main-agent --from 2026-10-10T15:23:00+08:00 --until 2026-10-10T15:43:00+08:00 --max-launches 2 --output artifacts/native-system-20261010-1523/results -- tests/candidate-copy.spec.ts tests/native-desktop-acceptance.spec.ts`。源测试输出、精确资源归属及程序结果保留在 `desktop/artifacts/native-system-20261010-1523/`，人工反馈另记 `verification.json`。末次自有 PID 已退出，userData/夹具目录已清理，`test:app:status` 为 absent；库由自有夹具正常退出清理，未另做 PG 目录查询。只处理合成资料，未读取原私人剪贴板；系统文件选择器初始默认目录展示文件名，但未打开其他文件。

  Finder 仍缺与最终包匹配的受控隔离启动路径，不能通过启动默认业务配置冒充验收；微信测试会话虽已准备，现有最小采集生产路径仍缺，CUA 全窗/整棵 AX 及旧整窗后裁剪均不在允许范围，本轮没有读取微信。WCDB 精确构建/许可、初始化/真实同步、定位/权限与退出停读仍缺；State/Triage、原依赖及四项验收全部保留。最终签名/类型/安全检查与独立两轴评审随后补齐。

  补提示后的 `npm test` 类型检查及 38/38 安全组通过（10.65 秒），没有再启动 App 或重跑原生组；候选包实机前后 `codesign --verify --deep --strict --verbose=2` 均通过，`npm run test:app:status` 再次 absent。4 份改动文档的 65 条本地链接、总清单 13 项（讨论8/实现3/验收2）、本票 open/needs-info 与四项未勾、`git diff --check` 均通过。分开的用户反馈和末次自有资源只读复查已写入上述忽略目录的 `verification.json`，独立双轴复核随后补齐；未新增权限、私人数据、模型预算或远端操作。

  固定 `8af1e8e → af273be` 初评 Standards 硬违规/建议 0/0；Spec 指出 P2：原生结果的 `systemShortcutHide: true` 只根据窗口不可见，不能证明隐藏来源。已改为 `helperShownObserved`/`helperHiddenObserved`，并明确 `humanShortcutAcceptanceRecorded: false`；机器结果不代替用户反馈。原运行 JSON 不改写，`verification.json` 另说明旧字段仅表示窗口状态；只修正证据字段及提示，没有再次启动 App，类型检查与增量复核随后补齐。

- 2026-10-10（用户继续：人工验收反馈收口准备）：原流程观察到隐藏就退出，用户反馈来时 App 已停止，影响人工验收。只修改本票既有原生场景的配合流程：显示/隐藏各在状态观察后生成随机请求并等待协调者依据对应用户反馈写入布尔收据，两次明确确认后才写入人工验收结果并正常菜单退出；缺失、否定或非法收据不通过，不根据窗口状态自动确认。响应仅本轮自有输出路径、普通文件、不跟随符号链接、最大 1 KiB，旧请求不能复用；每步反馈最多 90 秒、单场 8 分钟与预约截止优先，失败继续自有夹具/门禁收尾。没有改产品功能、后台数据/权限、公共 App/HTTP 接缝或依赖图，也没有新增自主 Harness；这只是原人工场景的必要协调 I/O。现不再次启动 App，新流程实际现场仍待新的有限预约，原 2/2 历史记录与隐藏未确认不变。本票仍 open/needs-info、四项原验收未勾；最小类型/静态检查及两轴评审随后补齐。


## Answer

### 2026-10-12 当前签名包与Finder启动收口

用户本轮指定的当前签名包与Finder启动两项已完成，原第1条据实勾选，State改为claimed，Triage仍needs-info。原四条验收文字及依赖图保持；完整交付票还缺WCDB精确构建／许可、18定位以及剩余渠道／原生链路，不把本次两项通过写成整票resolved。新增功能冻结，OCR继续暂停，后续操作沿用用户本轮授权，没有再逐次询问。

- 当前产品源码固定`b6fed39f`，后续仅增加验收夹具与记录，`desktop/src`、`backend/src`、`native/macos`无变更。离线 `npm run package -- --helper-directory <此前固定发行runtime> --helper-version 1.6.25 --helper-source https://github.com/r266-tech/wechat-cli-releases/releases/tag/v1.6.25 --with-probe --output-directory <本轮独立packaged> --electron-zip-directory <本轮离线归档>`成功。ASAR只含dist及最小清单，6份资源与最终当前dist逐字节一致；CLI/WCDB原发行字节与仓库探针／核心库共4文件的哈希、arm64和严格签名通过。运行前后主包deep strict均通过，主包仅allow-jit、helper无该权限；ATS任意加载false，无新增相机／麦克风／蓝牙声明。
- 同一包在10:40–11:00有限`test:app`窗口实际执行 `assistant-native-lifecycle.spec.ts`：1／1、14.4秒（runner14.7秒）／exit0、两次启动。小窗close继续、quit持久化中断、旧完成保留、迟到无效、同目录重开模型delta0及明确retry delta1全部保持，受控模型共4次；不是外部模型质量冒烟。
- `finder-package-acceptance.spec.ts`在同一有限入口预留1次真实Finder启动，由主Agent CUA实际双击最终`.app`。公开管理／配置页面显示`notalone://app/`资源、本机服务已连接、机器环境已就绪及配置的绝对Python；打开／隐藏输入小窗后，从公开菜单退出。认证HTTP running、App／后端PID退出及握手移除均核对；默认userData只整体暂存、不读取原文件，退场后原目录dev/ino恢复。完整复验 **1／1、约2.1分钟／exit0**，实际1次启动；此前约5.3分钟的一场因Root回执未赶上3分钟等待而exit1，操作与清理已完成但不算整场通过。仅协调等待改为5分钟，全场8分钟及原预约截止仍优先。
- 本轮合计4次实际App启动（包内生命周期2＋首次Finder1＋完整Finder复验1），未再启动。纯合成Finder目录保护2／2、完整TypeScript、默认安全40／40（12.744秒、不运行App）、diff及相对链接检查通过。两轴初评同一P2的未知后端清理问题已修正，复审0；最终证据另做两轴只读核对。
- Root新PG连接检查3份精确自有随机库均不存在，记录的6个自有App／后端PID均不存在，原目录身份恢复，测试userData／夹具／暂存目录无剩余，App与页面租约absent。原配置文件内容未读取，不修改业务库、TCC、权限或已安装App。没有真实微信、OCR、外部模型、聊天发送、push或部署。

产物：`desktop/artifacts/final-package-20261012.IgUojn/packaged/NotAlone-darwin-arm64/NotAlone.app`；归档`desktop/artifacts/final-package-20261012.IgUojn/NotAlone-macOS-arm64.zip`（140254252 bytes，SHA-256 `b7fdfbc3b6f9983282210c25ff88ff9902fc6bd943e3bbb56c850cd16c79acea`，ZIP完整性通过）。CLI发行许可／说明随归档同级保留；不声明缺失的WCDB构建／许可已完整。

[无敏感验收摘要](../../unfinished-work/final-package-finder-20261012.json)保存固定源码、实际命令、通过与失败分场、清理及完整交付边界；原始CUA画面、测试库名、PID和临时路径不提交。本包为**本机ad-hoc签名**，没有Developer ID／公证分发验收；源App旧结论、旧包及本次同一包结果分别保留。用户指定的这两项收尾完成，其余原20依赖继续按原范围处理。
