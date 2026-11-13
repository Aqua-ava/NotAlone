# 01 日志模块、滚动、`diag` 命令与隐私单测

Triage: ready-for-agent
State: resolved
Blocked by: 无（用户已于 2026-11-11 同意依赖、默认开启与设置页入口，见 [spec](../spec.md) 第 6 节）

## 内容
- 核对 pino、pino-roll 的锁定与安装版本，阅读源码与类型后再实现；用户已同意新增；安装前核对版本与供应链，不通过则改自行实现并回报。
- 共用 `diagnose(event)`：同步白名单校验、异步批量写入、失败静默；事件注册表（事件名、允许键、级别）。
- 文件：`logs/` 下按进程名与日期命名；目录 0700、文件 0600，拒绝符号链接；每份约 5 MiB，总量约 50 MiB／14 天封顶（数值以实测校准）。
- 级别与默认：正式版 info，开发实例 debug，排查模式限时 debug；高频事件聚合。
- 设置页"诊断日志"区域：开关（默认开启）、清除日志、占用大小、导出诊断包；中文文案，在实际 App 中验证。
- `pnpm run diag`：`--since`、`--module`、`--level`、`--trace`、`--slow`。
- 隐私单测：遍历调用点断言字段不越界；含敏感样例字符串的合成输入不会进入日志。
- 开销实测方案：同一工作负载开关日志对比，含启动耗时基线。

## 完成条件
- 单测与滚动／封顶测试通过；合成事件验证 `diag` 过滤；实测对比数据写入 `## Answer`。

## Comments

- 2026-11-11 实施决定：经 SHA512 与 npm 注册表签名核验，使用固定 pino 10.4.0。pino-roll 4.0.0 源码无法保证 O_NOFOLLOW 安全打开和写前封顶；用户已选择保留 pino，仅自行实现安全异步写入与轮转。

## Answer

实现与最终验收均已完成，State 为 resolved；实际开发实例启动对照、设置持久化与独立两轴复核结果见下方「最终验收与结案」。

- 用户已确认改为 pino 10.4.0 负责结构化序列化、有界内存队列配合自行实现的安全异步批量写入与轮转；不安装 pino-roll。安装前实际下载核对两个候选 tarball SHA512、npm 注册表 ECDSA 签名均通过；pino 有 provenance，pino-roll 没有。pino-roll 源码的路径创建／reopen 无 O_NOFOLLOW，且大小轮转在写后执行，因此经用户选择采用安全写入实现。已读 pino.js、pino.d.ts 的 base/timestamp/formatters/destination 合同与 pino-roll JSDoc/README/实现。`pnpm --filter notalone-backend-ts-validation add --save-exact pino@10.4.0` 成功，实际安装版本与锁一致；锁文件只新增 pino 与必要闭包 97 行，未重排或更新既有依赖。
- 共用模块位于 `backend-ts/src/diagnostics/unified-contract.mjs`、`unified-log.mjs` 与 `unified.ts`。所有写入、查询及导出均使用同一事件注册表，未知事件、字段、任意原因／调用者／状态字符串、异常和 getter 均整条拒绝。编号限 UUID，联系人前缀限 8 位十六进制；不保存正文、昵称、备注、路径、凭据或异常原文／堆栈。
- 最终磁盘预算：main/backend 各 24.5 MiB，控制文件与其原子替换临时文件合计预留 1 MiB，日志目录最多 50 MiB；每份 5 MiB，14 天到期，启动与按日／按大小轮转均清理，写前核验容量。目录 0700、文件 0600，核验属主、真实根路径和 inode，拒绝符号链接及硬链接。共用缓冲策略为 4096 条 decision／128 条 debug detail；writer 字节预算 8 MiB，其中预留独立溢出提示 64 个贡献槽及 6 个阶段的保守余量。高频 debug 合并次数与耗时；决策与 error 不主动采样，容量耗尽时汇总丢失计数。跨清除边界无法证明观察归属的事件／溢出提示安全丢弃，不能重标成清除后的新观察。正式默认 info、开发 debug，临时 debug 最多 30 分钟后恢复。
- 设置页加入中文「诊断日志」区域，含默认开启开关、占用、清除、本机诊断包导出。仅管理窗口可用，preload 和主进程都拒绝额外参数。开关原子保存到本机 0600 文件。clear／eraseContact 返回真实结果，失败不会宣称清除完成；04 接入删除时须协调后端唯一写者与在途任务。
- `pnpm run diag` 可按 `--since 10m`、`--module`、`--level`、`--trace`、`--slow` 过滤；`--trace` 也纳入 interruptedTraceId 指向该操作的失效记录。`--data-dir` 仅供明确本机日志根的隔离验证；输出不包含路径。

验证命令与真实结果：

1. `node --test backend-ts/test/unified-diagnostic-*.test.mjs`：12/12 通过，覆盖事件／字段越界、敏感合成输入、调用点静态遍历、私有权限、符号链接、并发 flush、跨进程预算、写前／按日轮转、14 天清理、临时 debug 到期、高频聚合、联系人前缀清除及 CLI 时间线过滤。主 Agent 已独立重跑 12/12。
2. `cd desktop && node --test tests/unified-diagnostic-bridge.test.mjs`：2/2 通过，覆盖管理页角色、双层参数白名单、导出再校验、篡改敏感行不进入诊断包、0600 与符号链接拒绝。
3. `pnpm --dir desktop run typecheck`、`pnpm --dir backend-ts run typecheck`：均退出 0。`pnpm --dir desktop run test:inventory` 通过（safe-node 162 等，仅登记验证）。未打包或运行打包版。
4. 主 Agent Computer Use 实际开发 App：看到设置区中文说明、默认开启；关闭后复选框取消、磁盘 enabled=false／0600；本机导出实际保存成功，formatVersion=1、automaticUpload=false、records=0、0600，验证样本已删除；清除后显示已清除和 0 KB，布局与公共 button 样式一致。开关跨重启持久化已由主 Agent 完成，实际启动对照见下方结案记录。
5. 最终集成开销：`NOTALONE_DIAGNOSTIC_SAMPLES=12 node backend-ts/scripts/benchmark-diagnostic-logging.mjs`，运行时代码冻结于 `7d627a7cd`，Node 退出 0。darwin/arm64、Node v24.22.2、debug 级；正常隔离 SQLite／同步／提取入口，固定合成模型、不联网。沿用一轮预热与每类 12 次交替样本，样本间 flush 不计入业务耗时，业务计时包含内部日志校验、排队及并发写盘。关闭→开启：管理读取 mean 1.2095→1.1977 ms（差 -0.0118），p50 1.1831→1.1915，p95 1.4612→1.4443；同步 mean 6.1832→6.5397 ms（差 +0.3565），p50 5.8120→6.3310，p95 7.5364→8.3966；提取 mean 201.4709→202.0776 ms（差 +0.6066），p50 212.3667→214.8104，p95 251.5459→251.4247。两组模型调用各 26 次（包含预热），rejected／dropped 均为 0；关闭落盘 0 条，开启 13081 条。内部模块记录：管理 357、同步 903、处理 11595，另联系人 148；确认比较覆盖最终内部接线。负差值和分位数波动不能解释为日志提速，也不能宣称无性能影响。

数据处理影响与剩余风险：仅增加本机无正文诊断、非秘密开关／删除抑制控制文件和用户主动导出；不增加上传、模型权限或消息发送。最终 12 样本覆盖管理／同步／提取的已接入内部日志，但使用合成模型与 CLI 适配器，不证明真实供应商网络耗时、完整微信同步或整套 UI 性能。冷 Node 模块启动与主 Agent 的真实 Electron／DSH 启动分别报告。队列有界、异步；进程退出、容量耗尽、写盘不可用或删除边界不确定时可丢失诊断，不改变业务授权和结果。联系人／账号清除通过共同维护锁、原子控制文件和观察时刻／前缀守卫阻止旧队列复活；控制容量耗尽或安全核验失败时不得假称清除完成。跨清除边界不能拆分的保守溢出摘要可能整体舍弃，日志不能被当作完整审计台账。独立审查与公开历史检查结论由主 Agent 在最终集成收尾中汇总。

### 审查修复补充

- P1：事件名在注册表查键前强制要求原始 string，拒绝通过 toString 匹配注册事件、再用 toJSON 序列化敏感内容的对象。新增实际私有文件回归；原代码确实写入合成 canary，修复后整条拒绝且自定义转换调用为 0。其余动态索引已核对：允许字段来自 string 键集合，module／caller／reason／state 使用不做隐式转换的严格 includes，编号和数值有 typeof 校验。
- P2：初始化记住已清理的 UTC 日期，日期变化时先 prune 再选取新日文件。独立回归在同一实例把 now 推进 16 天、不重启且不达到大小上限；原代码保留旧文件，修复后只保留新日记录。
- P2：活跃日志使用受限于枚举时字节数的完整行快照，允许普通追加；每份仍校验属主、权限、O_NOFOLLOW 和 inode，未完成尾行不输出。单份轮转／删除／不可读或不安全的邻接文件不再清空其他安全文件的时间线。设置文件和前缀清除的严格读取合同保持原样。
- 真实文件并发回归：预先写入 main 400 条、backend 1 条，main 持续每批追加 4 条并 flush，同时读取 80 次。原代码有 9 次丢失已有记录；修复后 80 次均保留至少 401 条，写完总计 801 条。另覆盖未完成尾行与不安全邻接文件，不跟随链接且保留完整记录。
- red → green：`node --test backend-ts/test/unified-diagnostic-regression.test.mjs` 首先暴露 P1／日期问题；`node --test --test-name-pattern='持续追加' backend-ts/test/unified-diagnostic-regression.test.mjs` 独立暴露 9 次读取丢失；修复后新增 4/4 通过。相关验证 `node --test backend-ts/test/unified-diagnostic-*.test.mjs` 16/16、`cd desktop && node --test tests/unified-diagnostic-bridge.test.mjs` 2/2 通过；`git diff --check` 通过。
- 开工核对当前 HEAD 858cdfce3，`pnpm --dir desktop run dev:status` 返回开发 PID 25612，复用监督器，不自行打包或启动第二份。仅处理合成临时目录（0700／文件 0600），测试清理全部临时资源；没有读取真实库、改业务资料或增加外部请求。审查修复时 State 保持 claimed；现已由下方最终验收结案记录改为 resolved。

### 最终验收与结案

- 实现提交：`57b0c1611`；审查修复提交：`8100de58f`。主 Agent 已亲读修复 diff 并重跑统一诊断 16/16、桌面桥接／导出 2/2；原两轴审查者独立复核三项修复均通过，无新发现。
- 实际官方 `pnpm run dev`、同一 HEAD `8100de58f` 的启动对照，每种配置各 n=1：关闭日志时 main spawn→ready 597.613750 ms，backend childPid 账本记录→握手 16656.006600 ms，main spawn→backend ready 17372.105300 ms；开启日志时分别 481.491666 ms、15078.135300 ms、15616.992300 ms。测量覆盖真实 Electron／DSH 启动，均为本机已连接状态。
- 启动结果仅单样本，受到缓存、运行调度等影响，不能解读为日志提速或「无性能影响」。此前无日志接线基线 main 526.32 ms／backend 17610.19 ms 的测量与本次之间还夹入联系人分组提交，不能作为严格相同代码的日志开销因果对照。冷 Node 模块初始化与真实 App 启动分别报告；最终业务开销已在 7d627a7cd 冻结后补齐 12 样本对照，见上述第 5 项与下方记录。
- 实际设置页持久化闭环：关闭后重启，开关仍为 unchecked；点击开启，再重启仍为 checked。日志开关现已恢复 true，本机服务已连接。此前实际界面的中文文案、占用、清除与真实本机导出验收仍有效；日志只留本机、没有上传。
- 当前 01 完成条件已满足，State 改为 resolved。后续 02–04 接入开销补测已由主 Agent 派发并完成（见下方）；本次只补端侧任务记录，没有再改运行时代码、重跑已有验证、打包或清理仍被开发监督器引用的观察目录。

### 最终集成性能补测

- 最小补强仅在既有 benchmark 脚本加入开关写入／writer 可用性、内部模块落盘计数与相同模型调用数核对；没有改变原工作负载、计时边界、预热或交替策略。`node --check backend-ts/scripts/benchmark-diagnostic-logging.mjs` 与 `git diff --check` 通过。最终采样命令及完整业务结果见第 5 项。
- 冷 Node（各 12 样本）mean／p50／p95，单位 ms：无诊断导入基线 19.4402／19.2304／21.3623；关闭日志 30.1898／30.0585／32.4930；开启日志 30.4133／30.0061／32.3990。开启−关闭均值差 +0.2235 ms，开启−无导入基线 +10.9731 ms。这是冷进程加模块导入／初始化，不能替代真实 App 启动验收。
- 可靠结果 JSONL 留在端侧 `/private/tmp/notalone-final-diagnostic-overhead-48igMa/results.log`，目录 0700、文件 0600，`exit-code` 为 0。首轮 shell 使用 zsh 只读变量导致退出码记录失败，未将其数据混入最终统计；该无可靠退出码的重复目录已删除。所有合成业务目录、SQLite 与冷启动目录均由 finally 顺序关闭资源后删除，最终进程退出 0。保留的结果仅有数字、固定事件／模块枚举，不含正文、联系人身份、路径字段或异常原文。
- 本轮复用已存在的官方开发实例，不启动 App、不操作桌面、不打包；未触碰另一会话的临时诊断、原三处未提交改动或其他生产／测试文件。当前 State 继续为 resolved，真实 App 启动与界面最终复验由主 Agent 独占协调。
- 本轮基准补强单文件提交：`9d599422d`；提交后 `node scripts/check_public_history.mjs --ref HEAD --working-tree` 退出 0、issues=0。此后所有文件保存冻结，等待主 Agent 的真实 App 启动对照。

### 主 Agent 最终实际开发 App 验收

- 最终运行时代码 `7d627a7cd`，性能脚本增强提交 `9d599422d`。主 Agent 已亲读生产/独立回归/基准脚本 diff，亲跑后台全部统一诊断 84/84（3.65 秒）、桌面 trace/bridge/startup/foreground 12/12（1.31 秒），真实命令退出 0。两轴独审的 6 项边界均经独立 red→green 后关闭。
- 官方 `pnpm run dev`，每个配置各 n=1，关闭→开启：main spawn→ready IPC 466.846083→432.079458 ms；backend 子进程启动账本→握手 17839.052734→16267.347412 ms；main spawn→backend ready 18247.862792→16646.980625 ms。与早期未接入基线之间有其他功能提交；本轮单样本受缓存/调度影响，不能解释为提速、零影响或严格证明无回退。纯统计证据 `/tmp/notalone-final-app-startup-summary.json`（0600）。
- 实际默认开发实例看到中文「诊断日志」区和 checked 开关；关闭后正常退出/重新 `pnpm run dev`，服务连接且开关仍 unchecked；恢复开启，再移除本任务 Node 观察钩子并启动普通开发实例，服务连接且开关仍 checked。开关已保留 true。
- 在真实 App 点击清除，显示 0.1 KB 及「已清除诊断记录。短期删除保护信息将在14天内过期。」；实际布局检查通过。点击导出并在本机保存成功，包含 35774 条 main/backend 记录，逐条通过同一事件注册表，formatVersion=1、automaticUpload=false、0600/属主正确/nlink1；没有 observedNs/clearedNs/抑制控制内容。验收导出文件已删除。
- 启动观察器进程均已正常结束；核验普通开发实例不引用钩子后，清理本任务观察目录（316751 bytes），只保留无正文/无路径的统计摘要和当前开发日志。没有打包或运行打包版，没有推送。

最终扩大检查：桌面默认 `pnpm test` 退出0（1355通过/1既有静态EApp环境跳过）。后台全量当时2287通过/12失败/2取消；其中05夹具遗漏已按原归属由9304b8cec修复并由主Agent16/16复验，其余13个图片相关失败/取消已用固定旧提交及有效合成PNG控制归因，交并行图片任务；不能宣称后台全量通过，详见04 Answer。最终公开历史+工作区检查HEAD9304b8cec issues=0；仅原3WIP留存。

### 本轮重新执行的设置与至少五次启动验收（2026-11-11）

本轮实际执行 `pnpm --dir desktop run dev:status`，初始stopped/exit1，无已有开发实例才通过官方 `pnpm run dev` 启动；随后多轮status为development/exit0，均再以实际App确认服务连接。未打包或运行打包版，未更改业务、同步或模型设置。

设置页实际操作及四次截图核对：初始开关checked；实际导出成功及占用21.2MB截图；关闭unchecked及占用22.8MB截图；一键清除后0.1KB及中文短期保护提示截图；最后恢复checked截图。截图均在新进程未选联系人时拍摄，头部显示选择联系人占位，未截入姓名或业务正文；仅在工具会话核对，没有提交截图。

本轮真实Node检查命令为 `node --input-type=module` here-doc（lstat/readFile/JSON.parse/checkedDiagnosticRecord，失败即非0）：导出88495条，全部注册表有效，formatVersion1/automaticUploadfalse，0600/属主正确/nlink1，目标姓名及正文/昵称/路径/凭据/stack/内部单调和删除控制字段均未出现；exit0，验收包删除。关闭后磁盘23950766 bytes对应22.8MB，与UI一致，权限校验通过；一键清除后统一JSONL文件0份，只保留92bytes维护控制，UI0.1KB；两项命令均exit0。开关最终恢复true并由普通开发实例确认。

启动测量全部是本轮新数据：主Agent先亲读私有observer/launcher/summary源代码并查证开发监督器ready IPC、后端spawn后childPid账本及握手。唯一启动行为为 `pnpm run dev`；observer只在监督器观测，不在main/backend改变业务，不读取握手凭据正文。每轮经CUA正常退出，私有helper拒绝已有实例并核对已持久化的开关，执行 `node "$observer_root/launch.mjs" on N` 或 `off N`（N=1至5），每条真实命令均exit0、reasonCode=ready；轮后实际App均已连接，开关与分组一致。顺序是on1/off1/on2/off2…on5/off5，十个不同main PID/phase，无丢弃或失败样本。采样窗口其它Agent暂停全量、单例、归档和编译；普通后台同步沿原配置运行。最终 `node "$observer_root/summarize.mjs"` 输出complete，failed0。

| 轮次 | 关闭main(ms) | 关闭backend(ms) | 开启main(ms) | 开启backend(ms) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 459.308 | 18587.516 | 427.341 | 16820.479 |
| 2 | 489.199 | 19974.608 | 446.809 | 17601.805 |
| 3 | 437.398 | 17629.768 | 466.556 | 17251.969 |
| 4 | 454.055 | 17110.942 | 462.305 | 17157.528 |
| 5 | 442.531 | 17065.471 | 460.892 | 17231.802 |

| 配置（各n=5） | main均值(ms) | main最大(ms) | backend均值(ms) | backend最大(ms) |
| --- | ---: | ---: | ---: | ---: |
| 关闭 | 456.498 | 489.199 | 18073.661 | 19974.608 |
| 开启 | 452.780 | 466.556 | 17212.717 | 17601.805 |

主进程为spawn至开发ready IPC；后台为实际子进程启动账本写入至握手，包含真实Electron/DSH准备。此次开启组main均值低3.718ms、后台均值低860.945ms；这是相同代码/资料根的交替热重启样本，不是OS冷启动随机试验，后台正常工作与缓存/调度仍可能造成差异。五次实测的均值及最大值没有显示开启组变慢，不能据此宣称日志提速、零开销或一般性无回退；本段五样本结果替代前文单样本作为本轮启动验收依据。State保持resolved。

规格同步本轮真实执行 `sed -n '166,176p' architecture/current/privacy-deletion.md`、`git check-ignore -v architecture/current/privacy-deletion.md`、`git ls-files -- architecture/current/privacy-deletion.md`：四项内容均已具备，ignore命中且tracked清单为空，均exit0。本轮不制造重复修改；该本地规格内容受Git忽略、不在提交里。

本轮最终复原：最后一轮off5在实际设置恢复checked，截图确认；正常退出观察实例，去掉NODE_OPTIONS观察器后再通过普通pnpm run dev启动，dev:status=development/exit0，实际服务已连接且开关仍checked。主Agent用Python从10条原始数值独立重算所有mean/max，与Node汇总逐项一致。确认全部旧观察器进程退出后删除22834bytes私有observer/helper/config及pointer，保留0600纯统计；原始开发stdout及多余定位查询亦已删除。跨日收尾完成于2026-11-12；没有新增生产或测试代码修改、无新增提交，验收基准仍9304b8cec。

本轮最终公开历史+工作区检查exit0/issues0，git diff --check通过，HEAD9304b8cec且仅原3WIP。后台13项未通过的每项旧树对照及因果控制现均完成，详见本轮验收清单；当前全量仍为2288通过/11失败/2取消，未修图片。
