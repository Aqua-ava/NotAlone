# 同步减负 01：来源判据、写入清单与隔离回放基线

日期：2026-11-07。代码基线：`64376743d`。对应本机任务单 01；本阶段不修改产品代码。已获用户授权的后续行为是“元数据一致即原地恢复”，ADR 和现行规格的行为变更随 02／04 交付。

## 来源核对的精确判据

判据基于正式读取器实际给出的 `HistorySupportReport`、`HistoryTarget`，不以昵称、正文、时间或进程重启次数证明身份。数据库中的已授权 token 必须先经 `identity.eligibility` 取得；下表不能恢复被撤销的授权。

| 维度 | 相同 | 仅增长 | 变化／反例 |
| --- | --- | --- | --- |
| 用户、联系人、绑定与授权 | `owner_id + contact_id` 隔离；当前有效绑定、有效授权和删除代次同时匹配 | 不自动扩展到其他联系人或撤销项 | 换联系人、换绑定或授权／删除代次失效：拒绝，不改身份 |
| 账号稳定键 | 报告 `accountKey` 与有效账号、保存的来源证明一致 | 不存在可接受的账号增长 | 换账号：停读，保留待确认状态 |
| 会话稳定键 | 报告 `conversationKey`、token 的 `conversation_id` 对应同一稳定会话 | 不存在可接受的会话增长 | 换会话：停读，不猜测合并 |
| 来源代次 | token、报告、目标和保存证明的 `sourceGeneration` 一致 | 不存在可接受的代次增长 | 微信库重建／代次变化：停读 |
| 已检查物理文件集合 | `checkedPartitions` 集合完全一致 | 当前协议仅支持这些已检查文件内部新出现会话表 | 分片文件新增、消失或被替换均不能仅据“增长”放行 |
| 会话所在分片与表实例 | 全部旧 `(partition, instance)` 保留 | 读取器声明 `partitionGrowth: supported`，支持档满足 `isPartitionGrowthTargetChange`，且旧表完整保留、仅增加新表时允许 `growth` | 缩表、旧表实例替换、root page／SQL／结构改变：拒绝 |
| 文件身份 | 原生 `notaloneSourceFingerprint` 的文件名、inode、创建时间和普通文件链接数相同；目录忽略链接数变化 | 文件正常追加、WAL／SHM 创建和清理不改变来源实例 | 文件替换，即使文件名与消息数相同，仍须拒绝；原生持续守卫负责本次读期间的变化 |
| 支持档与 schema | 来源协议、支持资格、认证能力仍成立 | `schemaVersion` cookie 单独变化不视为表结构变化；允许的加表由完整结构核验后再认证 | 未知能力、表结构或索引变化、无法核验：停读，不能用旧支持档替代当前核验 |
| 运行进程／租约 | 仍需本次读取的活快照守卫 | 新进程／新 `runtime_id`／旧 `lost` 本身不说明来源变化，应重新核对上列元数据 | 元数据核验不可用则保持停读；不能仅因进程退出新增来源围栏 |
| 续读锚点（02 增补） | 当前表末尾有界重读与已存原始键及规范化资料一致 | 锚点之后的新 localId 按原始键去重接受 | 原始键相同而内容／身份不一致则保持待确认；锚点不证明任意更早消息绝无改写 |

直接可复用的 TS 判据为 `backend-ts/src/history/partition-growth.ts:100` 的 `historyTargetTransition`。当前“分片增长”术语实际允许的是**同一已检查文件集合内增加会话表**，并不许可任意新物理文件；若将来需要放宽文件集合，须另有读取器证明与反例测试。本任务不扩大该边界。

原生指纹查证来自正在使用的锁定读取器构建源码：`notalone_watch_darwin.go:94`（文件身份）、`notalone_history.go:134`（表实例由分片、表名、root page、SQL 指纹生成）、`notalone_snapshot.go:288`（快照实例核验）。上述文件属于本机受控的 CLI 构建源码，不加入仓库。

## 围栏写入点逐项分类

`rg -n 'fenceContinuity\(' backend-ts/src/history/sqlite/` 得到 18 个调用语句、19 个固定分支（`R01/R02` 共用语句）；另有重新认证失败的直接写入 `C01`，总计 20 个固定分支。A 为真实变化或无法建立可靠基线时保留停读语义；B 为运行状态的过度防御，应归入统一元数据核对；C 为旧重新认证专用，待 06 删除。混合条件分开标注。

| 分支／基线位置 | 触发条件 | 分类与后续处理 |
| --- | --- | --- |
| G01 `continuity.ts:92` | 租约 lost、跨 runtime，或绑定／会话／代次不一致 | B：前两项重新核元数据；A：身份不一致仍停读 |
| G02 `continuity.ts:96` | scope 会话／代次不匹配 | A，保留 |
| G03 `continuity.ts:97` | scope 没有目标基线但已有历史／抑制 | A，不能猜测既有资料来源 |
| G04 `continuity.ts:100` | 没有 scope 但已有历史／抑制 | A，需确认或建立独立来源证明 |
| T01 `continuity.ts:110` | 没有目标基线但已有历史／抑制 | A，与 G04／N05 归并同一判据 |
| T02 `continuity.ts:128` | 已存目标到新目标转移不成立 | A，保留；允许增长仍按上表 |
| T03 `continuity.ts:130` | 目标核验的无 scope 兜底 | B，收敛到统一基线缺失判断 |
| N01 `continuity.ts:171` | lease 绑定／会话／代次不匹配 | A，保留身份保护；不持久化进程租约 |
| N02 `continuity.ts:172` | scope 会话／代次不匹配 | A，归并 G02 |
| N03 `continuity.ts:175` | 证明不可解析或账号键不同 | A，保留 |
| N04 `continuity.ts:177` | 旧目标到当前目标转移不成立 | A，归并 T02 |
| N05 `continuity.ts:180` | 已有资料／抑制但无来源基线 | A，归并 G04 |
| N06 `continuity.ts:188` | 跨运行代次时 prior normal-use 或目标转移证据不足 | B：不以旧租约状态定来源失证；A：当前元数据仍无法独立核验则停读 |
| N07 `continuity.ts:192` | 读过历史但没有持久 lease | B，来源证明不应依赖进程租约行存在 |
| A01 `actions.ts:122` | guardAcquire 的既有 lease 与本次 guard 不符 | B，进程内互斥／快照守卫仍保留；实际身份不符另按 A |
| A02 `actions.ts:125` | 没有 lease 但已有 read_goal | B，同 N07 |
| R01 `actions.ts:143` | guardRelease 的 normalUse 不为 true | B，释放进程资源不等于来源变化 |
| R02 `actions.ts:143` | guardRelease 收到 sourceLost | A，当前读取确实收到来源变化时停读；不能广播给空闲联系人 |
| L01 `actions.ts:148` | markContinuityLost，scope 与 token 匹配 | A，保留真实来源错误入口及匿名诊断 |
| C01 `recertify-actions.ts:219` | 旧重新认证失败直接 INSERT OR IGNORE fence | C，02 原地恢复前保留安全失败；06 随旧流程删除 |

写入辅助函数 `continuity.ts:47` 在首次新增时推进联系人 `source_revision` 并记录匿名诊断；后续统一状态转移仍须保留这些失效／诊断语义，不能只换表名。

## fence／lease／scope 全部读写面

| 基线文件与位置 | 读写内容 | 分类／04 或 06 接线要求 |
| --- | --- | --- |
| `history/sqlite/continuity-schema.ts:4`、`guard-schema.ts:5` | 三表定义／迁移 | B，04 折叠迁移，不能修改历史迁移 checksum |
| `history/sqlite/continuity.ts:47–239` | fence 新增／检查；空范围恢复删除三表记录；scope 创建更新；lease 核验续期 | A/B 混合，统一来源核对与进程内守卫 |
| `history/sqlite/actions.ts:117–148` | lease 取得／核验／lost；显式来源失证 | A/B 混合，保留真正变化与互斥 |
| `history/sqlite/actions.ts:225,347–348` | scope 校验、来源记录资格查询 | A，改查新证明状态 |
| `history/sqlite/read.ts:31,49,82–83` | 读取资格／覆盖状态／当前来源范围 | A/B，来源阻断保留，移除 runtime 持久依赖 |
| `history/sqlite/source.ts:32–33` | 消息来源过滤与可选 runtime guard | A/B，来源状态继续约束可用资料，运行保护在进程内 |
| `history/sqlite/current-scope.ts:20` | 规范化当前来源范围 CTE | A，改从 source_proof 建立相同范围 |
| `history/sqlite/quote-store.ts:159`、`media/sqlite/image-sync-actions.ts:45` | 引用与图片的来源资格 | A，不能随并表放开失证来源 |
| `history/sqlite/deletion.ts:12–16,63–65` | 删除账本 rowKinds 与联系人／账号删除收集 | A，04 同时改为删除新证明，处理中旧账本行需兼容 |
| `history/sqlite/recertify-access.ts:17` | 原重新认证授权要求有 fence | C，02 适配原地恢复，06 删除 |
| `history/sqlite/recertify-candidates.ts:24,34,90` | 原批量修复候选与计数 | C，04 临时接新状态，06 删除面板和桥 |
| `history/sqlite/recertify-actions.ts:143–219` | 认证前快照、安装 scope/lease、完成清 fence、失败写 fence/lease lost | C，02 不 Rotate，04 临时接新状态，06 删除旧重认证账本 |
| `history/sqlite/superseded.ts:58` | 有 fence 时禁止清旧副本 | A，05 未完成前保留清理与保护 |
| `memory/sqlite/runs.ts:22–31` | 取当前来源范围，旧库兼容判断 | A，04 同时切换，不能遗漏记忆正式入口 |
| `reply/sqlite/actions.ts:48–50` | 回复出站输入中固化 scope/fence/guard 证明 | A/B，来源依赖保留，去除 runtime 持久租约语义 |
| `platform/cutover/structure.ts:21` | 本机迁移／删除范围表清单 | A，04 更新新表并保持删除闭包 |
| `storage/sqlite/contracts.ts:25` | 匿名诊断事件种类 `history_continuity_fence` | A，属于日志协议名称，不是三表 SQL 读写；继续保留 |

以上由 `rg -l 'history_continuity_fence|history_guard_lease|history_continuity_scope' backend-ts/src` 完整核对：18 个源码文件。旧迁移 SQL 的历史三表定义需保留用于逐级升级；“删除读写代码”指现行运行路径，不应重写旧迁移。

## 持久续读可行性与缺口

- 原生 `notalone_snapshot.go:600` 已按每表 `WHERE local_id>? ORDER BY local_id LIMIT ?` 读取追加；变化页另以 `local_id IN (...)` 读取旧记录变化。可复用快照、原始键去重、分片身份和终态处理。
- `NarrowWechatClient.resumeTargetSelected`（`native-client.ts:1140`）与 `WechatHistoryChannel.resumeTarget`（`wechat-channel.ts:96`）已支持读取器签发的 `durableIncremental` 游标跨进程恢复，并非所有 cursor 都不能跨进程；活守卫的 tail cursor 则不能由调用方拼造。
- 公共窄协议当前**没有**“调用方传各表已存最大 localId”和“按已存末尾原始键有界核对锚点”的入口。只复用旧 `resume-target` 无法覆盖丢失 cursor 的围栏联系人；02 需新增显式受控协议，仍由原生独立核验账号、会话、代次、文件和表实例，TS 不伪造 opaque cursor。
- 跨进程恢复的持久检查点仍要保留变化页语义：只用 `max localId` 会漏掉旧消息撤回／低编号补入；若仅为最小锚点续读路径，必须明确其有界检测局限，不能宣称覆盖任意旧行改写。

## 可重复副本回放

脚本：`backend-ts/scripts/verification/sync-metadata-baseline.mjs`。输入只允许指定的历史备份文件名，输出必须是尚不存在的 `/tmp` 临时目录；通过 APFS clone／文件复制建立新副本，原备份仅复制读取和核对 stat 身份。每轮只对副本正式 Worker 调用 `identity.eligibility` 与 `history.prepareNormalUseGuard`，正式 `SharedWechatClient` 是独立实例和独立子进程，不接管、不停止正在运行的真实读取器。

原生模式仅执行 `resolve`、`inspect`、`support`、`target` 元数据操作；正文页、增量正文、隔离页、图片、引用和边界读取全部在回放脚本硬拒绝，模型零调用。输出只有聚合数字，不包含会话名、联系人名、聊天内容或凭据。

该备份实际 `user_version=42`，大小 3,199,328,256 字节（约 2.98 GiB），不是文件名暗示的已升级 43。基线保存：59 围栏、831 绑定、407,139 消息、24,230 读取目标、141,085 抓取。当前正式 Worker 打开涉及迁移并执行完整完整性校验；首次使用正常客户端的 60 秒打开预算得到 `storage_timeout`，尚未执行任何元数据握手。回放脚本为大库升级**只延长自身打开等待至 10 分钟**，不跳过任何 Worker 校验、不修改产品预算；动作仍有 30 秒有界等待。这是与正常 App 启动的明确差异，正常 App 大库升级时延未在 01 修复。

验证命令（在 `backend-ts/`；`$BACKUP` 与 `$CLI` 是本机显式选择的备份和受控制品绝对路径）：

```bash
node --check scripts/verification/sync-metadata-baseline.mjs
node scripts/verification/sync-metadata-baseline.mjs --backup="$BACKUP" --user-data=/tmp/notalone-sync-baseline-saved-20261107 --mode=saved
node scripts/verification/sync-metadata-baseline.mjs --backup="$BACKUP" --user-data=/tmp/notalone-sync-baseline-native-20261107 --mode=native --executable="$CLI"
```

本轮两种回放均通过全部断言：221 位未围栏且有来源范围的联系人中，219 位有效、2 位没有有效读取资格；错误／拒绝／正文操作均为 0，原备份 stat 身份与修改时间不变。保存档回放使用的实际目录带 `saved-v3` 后缀（前两次分别暴露非规范 `/tmp` 路径和 60 秒打开超时），正式回放使用上列 `native` 目录。目录和日志仅留本机，不提交数据库。

每次重跑须换全新副本目录。脚本内断言有效联系人 219 位、219 位握手成功，且围栏／绑定／消息／目标／抓取计数逐项不变；可用 `--limit=1 --expected=1` 做最小正式读取器烟雾验证。

| 回放 | 元数据成功 | 围栏 | 绑定／消息／目标／抓取 | 耗时 |
| --- | --- | --- | --- | --- |
| 保存的支持档与目标 | 219/219 | 59→59 | 831／407,139／24,230／141,085，逐项不变 | 64,831 ms（含大库升级校验） |
| 正式 SharedWechatClient | 219/219 | 59→59 | 831／407,139／24,230／141,085，逐项不变 | 89,337 ms（含大库升级校验） |

## 数据影响与剩余风险

真实业务库未打开写连接，现有 15 位真实围栏不变；没有启动、重启、切换真实 App 或真实读取器，也没有点击修复同步。仅隔离副本会执行正式库迁移、推进运行代次、重验续租和使旧目标失效；不触发读取目标新建、抓取、正文导入、媒体提取、模型调用或副本清理。

历史 219 位围栏的写入入口仍无原始日志，不能把当前守卫登记缺陷写成其已证实根因。本轮回放仅证明当前元数据可核验，不证明任意正文未改写、不证明正常 App 端到端同步，也不代替 02／04 的五次重启和硬中断验收。新增 ADR、现行规格改写及真正原地恢复由后续任务完成。

## 独立审查

固定点 `64376743d`；Standards 0 项、Spec 0 项，无阻断问题。两个审查者均未参与 01 实现；审查读取脚本与匿名聚合记录，未重跑真实资料回放。
