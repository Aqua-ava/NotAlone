# 已有资料更新验证（2026-10-16）

任务：[04：已有用户备份并完成兼容更新](issues/04-preserving-data-update.md)。任务实现及内部组合验收已完成；2026-10-17同普通包最终复核见[组合验收](release-validation.md)。任务01的真正无开发环境与正式交付门槛保留。此记录仅认证下列实际覆盖行为，不认证微信接入、模型质量或使用者私人资料更新。

## 数据与实现边界

只使用本次随机 `_test` 数据库、独立用户目录和合成资料。旧结构由正式001–055 SQL建立；另一条路径使用正式035结构的真实审计基线，再运行036–055并保留真实账本。新目标使用当前正式迁移集合，不把未来新增版本当作历史漂移。夹具包含本人、联系人、规范消息、原始来源、候选／确认记忆、来源依赖、会话绑定、关闭的同步开关和暂停状态。

受管旧库在备份与真实恢复验证后逐版本更新；外置旧库复制到 App 自己的独立本机数据库，仅迁移副本。两条路径比较更新前已有业务列的完整摘要，新增字段不使原资料被误判为变化。更新不重提取记忆、不重建本人或绑定、不扩大授权。配置只延续明确的本人／模型项，不搬运开发命令、隐含出站或追踪变量。数据库URL及凭据不进入 argv、renderer 或错误日志。

用户确认只绑定本次只读核验的目标、配置与环境摘要。陌生连接不被杀死；迁移使用同连接 advisory lock，每版本SQL与账本原子提交。更新进程和数据库使用父寿命监督及共享锁，退出有界回收本次进程组。旧外置源在最后激活握手期间冻结，切换后恢复旧结构的连接门；崩溃恢复必须匹配原收据与指纹。

## 公开 App 的 red → green

首次真实 App 缺少“备份并完成更新”，20秒公开按钮断言失败，记录位于忽略产物 `desktop/artifacts/update-red/`。后端公开命令首次因缺少 `notalone.database_updates` 失败。

第一条外置更新在 v2 开发包通过（1/1，20.4秒）。v3 首次因 fixture 未调用 use 而未启动 App；修正后正常路径通过，漂移恢复用例因没有等待异步“正在只读重新检查资料”而失败，测试随后明确等待真实检查。该失败不解释为产品已通过。

使用完整标准源码运行时的 v4 App 通过：

| 路径 | 结果 |
| --- | --- |
| 外置055：公开按钮备份、复制、迁移、联系人及模型设置 | 1/1，19.9秒 |
| 历史漂移：拒绝更新、只读重检、修复本例漂移后正式更新 | 1/1，24.0秒 |
| 损坏激活检查点：专门恢复状态、无继续按钮、无后台／PG启动 | 1/1，2.1秒 |
| 受管055：公开更新、联系人消息／来源计数、本人模型保留、原生菜单退出、同目录重开 | 修正测试的 disposed-process 收尾引用后1/1，57.4秒 |

v4 的受管首次运行已经完成产品操作，但测试在取得已处置 Electron 对象的 process 时抛错，保留该失败；通过仅指修正后真实重跑。v4不含后续激活完成后源连接门崩溃恢复修复，不能将旧包结果补签为新字节通过。

v6 使用同一完整标准 v2 runtime，包含源门恢复、完成收据、Main重检／恢复 single-flight 与 receipt 非阻塞读取。主 Agent 实际 Computer Use 已通过1/1（4.4分钟，runner exit0），fixture仅管理生命周期与合成库，未代点业务UI。原配置的旧 Python 和项目确实不存在；公开更新后显示已连接、更新完成、原本人和模型已就绪。联系人保留1条消息／1份来源且未自动选择；明确选择后可查看已采纳／待确认关系资料及来源版本。同步页因无CLI显示未就绪，仅观察未操作，不将其作为同步开关UI认证。

管理设置不再要求开发路径；实际点击备份入口后Finder打开本次updates目录，自有Finder窗随后关闭。原生菜单退出后App、握手和PG锁退场；用同一userData重开保留本人、模型、联系人和备份入口，联系人仍未自动选择，再原生菜单正常退出。主Agent只读确认 checkpoint 为complete／restore_verified=true／activation_complete=true／source_gate=false，dump0600。两个App PID及本轮相关进程已退场，临时userData删除，租约absent。记录在忽略产物 `desktop/artifacts/update-cua-v6/`；未包含私人界面截图。

## 后端故障与回归

`tests.integration.persistence.test_database_updates` 通过真实PG命令覆盖正常旧库更新／副本接续、035基线与真实后续账本、错目标与陌生连接拒绝、恢复工具失败保留原库和私有归档、历史漂移只读拒绝。迁移中断场在真实最新版本提交后、下一条合成迁移睡眠时 SIGKILL 自有进程，重开观察连接门，按真实账本续接。

激活完成窗口场在真实原子 checkpoint 替换之后 SIGKILL，确认 `activation_complete=true` 与 `source_gate=true` 已落盘；错指纹释放拒绝，同收据恢复只释放旧源连接门，源账本仍为55。该新增测试单独1/1（4.844秒）通过。

最后完整更新组11/11通过（27.911秒），新增无写端FIFO检查点拒绝且原库55不变、OS容量返回0时在备份前拒绝且原库仍可连、已验证归档被本例替换为FIFO后立即拒绝。归档FIFO先真实RED（3秒阻塞超时），补NONBLOCK后GREEN；这项后端防护晚于v6，不能补签v6字节。容量测试替换OS边界，并非填满真实磁盘。

同一归档故障场随后扩展“检查点存在但归档缺失”：先RED返回generic `update_failed`，这会留下无效继续按钮；现将归档缺失、不可读及检查点打开失败统一为 `update_backup_invalid`，走专门恢复入口。该场包含真实正常更新、缺失归档和FIFO归档，定向重跑1/1通过（4.123秒），不减弱目标、恢复点或资料核验。

此前正确绝对 `PYTHONPATH` 的相关27项通过（47.77秒）。较早扩大回归误用了共享 Conda 的主树 editable 导入，产生4项失败和一份本例合成备份；已按文件身份、归档摘要与基线核对，将该自有目录移到忽略产物 `desktop/artifacts/update-test-import-misconfiguration/`，未删除未知资料。旧 adoption 测试的版本预期仍停在055，已明确补齐现有056–059名称；正确导入后四项定向重跑均通过（8.73秒）。原失败不覆盖。

最后扩大后端回归中更新8/8、迁移10/10、adoption23/24、父寿命1/1通过；adoption的035旧用例在只读audit调用后报告 `adoption_writers_present`，尚未取得连接归属来证明唯一原因；另一个诊断模块名误写成unit而未导入。修正命令后诊断9/9、原035定向重跑和新增两项故障合12/12（10.176秒）通过；没有减弱adoption生产连接保护，也不将原扩大运行写为全绿。

安全套件 `npm test` 首次为类型检查及安全调度／合成进程93/93通过；本命令不运行真实 App。最后Main窄防护后 `npm run typecheck` 通过，新增两项真实合成命令测试通过：无写端FIFO receipt公开恢复失败；并发重检只执行一次命令，忽略TERM的本次子孙在4.66秒内全部退场。加入安全套件后完整95/95通过（46.614秒）。

## 固定运行时与包字节

两次均通过标准 `node scripts/prepare-runtime.mjs --source-cache <本机固定源缓存> --output-directory <独立输出>`，由固定 PostgreSQL16.15 官方源码 `make -j2` 构建；79份源码归档、257份通知、70个 Mach-O 检查、8668库存及隔离导入通过。没有替换冻结集成包的原字节。

最终 v2 runtime 的 `manifest.json` SHA256：`eb67c456b52c7cee734544c9c355c671dfd2fbd72afbcdd35c3d437c5719ae82`。其中本项目 wheel 摘要：`176cdfcbb09070c09af9f18dfeeec9b2415babf6f01d7e2395047c8e32c5d2a2`。

v6 `database_updates.py` 源码、包内 project 和已安装模块三处 SHA256 一致：`8a79ae6812a27c60dfc773278a40ca76c779f07c7ab7f803fbc93dcca42eb20d`。v6 ASAR SHA256：`1dd5ed045d4b24664b00bd14a90fa94c20d16905321f838cc1d4d7d6a63e92dd`。包使用标准 `scripts/package.mjs`，deep／strict ad-hoc 校验通过。没有 Developer ID、公证或外部发布。

归档非阻塞与检查点可选字段防护后，曾启动第三次全量PG编译，收到协调要求后Ctrl-C退出130；精确检查无构建子进程。后续复用标准v2的同字节PG与全部来源许可，只在自有副本安装新普通wheel、更新项目源码和完整库存。它是定向验证副本，不冒称第三次标准全构建；最终04＋06组合将统一标准构建并重新覆盖关键路径。

v7定向副本（PG与标准v2全部文件相同、6个预期文件摘要变化、8666库存）通过包内 `-I -B` 隔离导入及真实公开CLI：旧055正常备份／恢复／迁移ready，FIFO检查点和FIFO归档拒绝，原目标仍可用，strict／deep签名通过。其ASAR与v6同字节，manifest为 `6bfd0bf4a90fa564485a1c2f19829f8830091b19c4c6f5fa754ee207c49caeae`。这组不是GUI重跑，不覆盖最后缺失归档错误归一化。

最后v8定向包 `desktop/artifacts/update-package-v8/NotAlone-darwin-arm64/NotAlone.app` 通过strict／deep签名；包内 `-I -B` 命令在正式055合成目标先拒绝FIFO检查点，再实际完成备份、恢复校验和迁移；同场将本例归档保留为 `owned-original.dump`，确认缺失归档和FIFO归档均准确返回 `update_backup_invalid`，原目标仍为ready。没有运行GUI。源码、包内project和已安装模块三处摘要相同；本轮临时库、目录和命令进程已收尾。证据位于忽略产物 `desktop/artifacts/update-runtime-wheel-v4/packaged-command-result.json`。

v8的PG全部文件与标准v2同字节；8666库存核验通过。本项目wheel SHA256为 `ea4780bbeb5989af39d5cb48e032fe496a18daeab38aaa9efa62e571443a8713`，manifest SHA256为 `66d81ed252542e98c670843be7b85512fc8f9906c68fb6cd566054d7e7d048fe`，更新模块SHA256为 `9cb7d3c7792f4e163940771bd6e906ee6883f289f31e689ba3c500b3eda78bed`。ASAR仍与v6 CUA包一致；不据此把不同后台字节写为同包GUI验收。

磁盘收口时只清理本任务自有 v2／v3／v5／v7 过期大 App 副本，以及旧developer／标准v1／wheel-v3运行时副本，保留相应manifest、ASAR摘要、签名验证结果和小命令证据在忽略产物。标准v2运行时、v4、CUA v6、最后v8及wheel-v4保留；用户原App、冻结集成包和未知目录未动。

## 真实命令与未完成项

2026-10-17组合复跑暴露4项失败后，以四场重复6轮复现两次激活前 `adoption_writers_present`。只在本例合成目标采样PID、backend_start、state、xact_start、application_name与backend_type，追踪已关闭自有连接；没有读取SQL正文或他库，没有终止未知连接。真实adoption失败一次及激活前失败两次的唯一阻塞行均为PostgreSQL内部 `autovacuum worker`，没有匹配已关闭fixture PID。此前035那次没有同时取证，仍不追认其唯一原因。

最小回归在自建私有PG集群将naptime设为1秒，实际观察autovacuum后调用同一连接门禁，2.213秒RED；修复仅在原count条件排除可信backend_type精确值，使用 `IS DISTINCT FROM` 保留NULL及其他类型拒绝，不按可伪装application_name放行。随后同场真实客户端伪装该名称仍被拒绝。完整相关56项64.258秒GREEN；没有更改共享服务配置、来源冻结或停止保护。PostgreSQL16对backend_type及事务统计快照的约定见[官方统计文档](https://www.postgresql.org/docs/16/monitoring-stats.html)。两处原先只报返回码的断言现附带固定白名单响应码，不输出原始stdout或凭据。

Python命令在 Conda NotAlone 下执行，显式绝对 `PYTHONPATH` 指向本工作树 `backend/src`，`NOTALONE_DISABLE_DOTENV=1`；只操作本例数据库。相关命令是 `python -m unittest` 的 `test_database_updates`、`test_database_migrations`、`test_database_adoption`、`test_startup_diagnostics` 与 `test_parent_lifetime` 模块。App用 `scripts/test-app.mjs` 明确限定上述文件、实际包、隔离目录、有限租约和启动预算；Computer Use hold 仅准备生命周期、合成库与随机nonce信号。

最后故障防护已完成定向副本包装、签名和包内公开命令核验；当前仍待独立双轴审查、最终04＋06同包组合及其真实相关全组复跑。adoption广测原失败保留，不能用定向通过覆盖该次失败。磁盘不足通过OS边界测试，尚不宣称真实磁盘耗尽端到端通过。损坏备份的恢复说明不等于自动恢复成功；产品不会覆盖原库。真正无开发环境首启、正式发行与微信验收不能由本票旧库合成验证代替。


## 2026-10-17 两项独立审查修复

已完成收据只可用于重连核验；后续版本有新迁移时，Main 生成新 UUID、新目录和新备份，仅未完成操作续接。`desktop/tests/data-update-cycle.test.mjs` 使用生产 LocalDataUpdates、真实命令／PG 与固定测试运行时边界：先055更新到当前正式集合，普通编辑联系人后增加一个仅本例的下一版本，再调用公开控制器更新。原逻辑在4.47秒 RED 为 `update_source_changed`；修复后第二轮产生新目录，旧归档摘要不变、联系人修改保留。模拟重连失败后重复操作只重连，pg_dump 次数不变。此接缝不启动 Electron，也不是包内隔离 Python 验收。

完整更新归档纳入明确删除：Main 仅传固定 App 资料目录；受限模块预检全部已完成 UUID 目录、私有普通文件、检查点及真实当前数据库指纹，再删除完整 dump。外置复制凭目的指纹核验，原外部库／用户自行另存的归档不删除。与更新共用 PG advisory lock，未知／未完成／损坏目录或任何清理失败阻止删除成功，返回固定 `update_backup_cleanup_required`；不默默跳过，不猜测其他用户目录。元数据检查点保留但不能恢复正文。来源、追踪、关系资料及助手会话原确认说明清除全部 App 更新快照；失败可通过现有具名无参入口打开固定备份根与恢复说明，缺失收据也可操作。已知归档自动清理不再要求额外确认，Main hasBackup 随实际删除刷新。

新回归最初2/2 RED：业务来源已 deleted，但旧 dump 仍能恢复正文，未知目录也未阻止成功。修复后真实 PG 7/7 GREEN（22.788秒）：来源删除前实际恢复可见正文，删除后归档不可用于恢复；公开 HTTP 删除抽取／导入追踪后全部 App 快照消失且原消息按其独立语义保留；复制目的删除清除 App 快照、原外部数据库及另存归档不变。未知目录以及损坏／未完成检查点均拒绝，原资料和归档保留；修回凭证后原删除可成功。固定失败响应为409且仅含安全代码。

扩大到10个旧删除／记忆／任务模块时，首次误用默认测试库，缺少041捕获墓碑表且无迁移账本，产生大量导入错误；不改该共享库。相同旧来源删除用例在66cd基线和当前均复现导入失败。改用本次随机自建、正式全迁移的 `_test` 库后179项中178通过，仅同一追踪收据对账用例的contact／self两个subtest失败；66cd同库定向重跑同样失败。另5项 MemoryTraceApi 的0模型调用／skipped预期差异也逐条在66cd复现，未为本次改动放松断言或改语义。上述扩大运行如实保留为未全绿，不用新定向通过覆盖。新建测试库按精确归属收尾，未更新默认库结构。

当前安全套件 `npm test` 97/97（47.050秒）和类型检查通过；最后 Main／真实 PG 组合1/1（7.235秒）通过；新增真实 PG 接缝须单独在 Conda NotAlone 运行 `node --test tests/data-update-cycle.test.mjs`，未加入不触真实库的安全套件。新增修复没有重编 PG、没有新运行桌面或调用外部模型；最终04＋06同包、独立复审及任务01发行门槛仍由主 Agent 接续，不关闭本票。
