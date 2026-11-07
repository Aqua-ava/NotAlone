# 同步减负 02：原地恢复与五次在线重开

日期：2026-11-07。最终在线验收通过：用户自行打开微信后，纯 02 冻结代码在指定历史备份的新副本上完成六个生命周期、五次重开和一次自有进程硬中断；每个完整轮次 278/278 成功，围栏恢复后始终为 0。账号／会话／代次／分片／表实例／文件身份六种反例，在存档元数据和当前原生元数据接口返回后注入两种方式下均拒绝并围栏。

以上只证明隔离副本与正式读取器／服务的行为；真实 NotAlone 应用、真实库和真实 15 位围栏未操作，也未部署新代码到主工作区。

## 输入、代码与运行边界

- 源为用户指定的 `before-migration-43-20261107.sqlite`：实际 3,199,328,256 字节、schema42；只读复制到全新临时目录，由正式 Worker 正常迁移至45。复制前后原备份 stat 身份、大小和修改时间不变。
- 副本有 278 位有效读取资格：59 位原本围栏、219 位未围栏。初轮仅用正式 `history.markContinuityLost` 给后者注入围栏，起点共278；未恢复另外10位无有效资格的授权。
- 最终循环从纯 02 冻结工作树运行，未注册的 04 并表切片不进入证据。仅使用正式 `SqliteHistoryService.synchronize`、正式 Worker named action、正式 `SharedWechatClient` 和正式窄渠道。
- 独立原生工件v3经正式固定 policy 的 `prepareAliases` 配对，428条 alias 绑定到新制品；CLI SHA-256为 `90443d9a27765ed35970e992009e7059793051fe703ce2e200f41694f9d6872b`。新旧制品完整来源范围对照为278/278 verified，零正文／配置写入；一次快照瞬时错误在独立进程有界重试后通过，未放宽比较。
- 真实微信由用户打开；Agent只读核对唯一进程、账号 verified、账号／来源代次相同、支持资格 supported、已检查文件8个、旧到当前目标转移为 same。Agent未启动／重启／切换真实应用或真实读取器。
- 大库回放直接运行正式 Worker，打开等待上限10分钟、动作等待60秒；不跳过完整性、FK或迁移校验。这与正常 App 的固定客户端等待预算不同，不能据此宣称正式 App 的大库首启耗时已验收。

## 最终在线结果

每个正常完整轮次均同步全部278位，零失败。硬中断轮在首位同步成功且原生守卫仍在时，以SIGKILL终止本脚本自有宿主（含 Worker）和1个自有 CLI；下一轮再同步全部278位。

| 生命周期 | 成功／失败 | 围栏 | 消息总数 | 含打开耗时 |
| --- | --- | --- | --- | --- |
| 0，恢复59既有＋219注入围栏 | 278／0 | 278→0 | 407,139→407,271 | 56,650 ms |
| 1，第一次重开 | 278／0 | 0→0 | 407,271 | 41,215 ms |
| 2，首位成功后硬中断 | 1／0，其余按计划未执行 | 0→0 | 407,271 | 23,874 ms |
| 3，硬中断后重新打开 | 278／0 | 0→0 | 407,271 | 63,940 ms |
| 4，继续重开 | 278／0 | 0→0 | 407,271 | 108,086 ms |
| 5，第五次重开 | 278／0 | 0→0 | 407,271 | 83,489 ms |

首轮核对2,682条有界锚点，读取133条各表最大localId之后的增量记录，新增132条消息；旧正文分页记录为0。后续轮次的正文记录均为0。首轮每联系人耗时中位102ms、最大910ms；整轮包含大库打开与其他准备，未据并发负载下的总耗时宣称性能优化比例。

绑定总数始终831，不撤销／新建绑定；九类派生与引用行数逐项不变：`memory=85`、`memory_candidate=373`、`memory_citation=932`、`memory_document=13`、`memory_document_version=13`、`reply_candidate=33`、`reply_candidate_version=33`、`reply_candidate_context=16`、`reply_candidate_input_source=773`。

`read_goal` 24,230→12,524、`sync_capture` 141,085→136,625：既有 `goal-retention.ts` 清理无 capture_record、认证／恢复或后继目标引用的旧空任务，增量接受也清理旧空抓取。本轮未调用旧绑定副本清理或用户删除；不能把空任务数量减少误记成消息减少。

## 六维反例：存档与当前原生元数据分开记录

两组均从指定 before43 备份建立基线，再克隆六份独立副本，运行正式同步服务和存储动作。先用未改动元数据执行正式 `history.prepareNormalUseGuard` 正向控制；每例只改一个维度，真正从59增加到60位围栏，绑定831／消息407,139／九类引用完全不变，正文方法调用0。

| 注入维度 | 存档元数据 | 当前原生接口元数据 | 实际拒绝码 |
| --- | --- | --- | --- |
| 账号 | 拒绝、59→60 | 拒绝、59→60 | history_external_scope_changed |
| 会话 | 拒绝、59→60 | 拒绝、59→60 | history_external_scope_changed |
| 来源代次 | 拒绝、59→60 | 拒绝、59→60 | history_external_scope_changed |
| 分片消失 | 拒绝、59→60 | 拒绝、59→60 | history_source_continuity_unverified |
| 表实例替换 | 拒绝、59→60 | 拒绝、59→60 | history_source_continuity_unverified |
| 文件身份变化 | 拒绝、59→60 | 拒绝、59→60 | history_source_continuity_unverified |

存档组只把已经保存的正式支持档／目标作为渠道边界替身，零原生调用，不冒充当前来源证明。当前原生组逐例通过正规 SharedWechatClient 取得当前 inspect／target，先确认其与当前正向控制一致，再在返回边界注入指定变化；前三例执行inspect，后三例执行inspect及target。为只检验元数据门禁，明确禁用适配器可选resume／recover捷径，未更改真实报告的任何能力，也未调用锚点或正文接口。

这些是副本上的渠道边界故障注入；没有切换真实账号、会话或替换真实微信文件，不宣称做过这些真实破坏性操作。

## 实现中发现并修复的边界

1. 空目标原支持档没有正文恢复能力，被 `history_source_recovery_unsupported` 阻断。TDD修复后仅旧零表且零锚点时走当前目标元数据核对，恢复cursor为null，不拼造opaque cursor。
2. 普通有表报告漏声明partitionGrowth，真实同一8个已检查文件内1→2表增长被拒绝。独立probe及渠道定位分别复现recoverTarget／resumeTarget的 `history_target_unverified`；修复真实能力声明、旧支持档兼容判据并正规配对v3。最终在线循环覆盖该来源继续读取，无误围栏。
3. 早期在线轮次中真实微信退出，177位成功后出现一次native_unavailable、继而100位source_unverified被旧分类围栏。只读确认微信进程数0：新进程可验证账号／代次和schema，仅支持核验因缺唯一实际微信进程失败。这是暂不可核验而非来源实变；TDD修复分类及协调器停读重试。100位失败副本现场保留，未人工清理。

修复暂不可用分类后，在微信保持未运行时另用全新副本完成六生命周期／五次重开／一次自有宿主与CLI硬中断：每完整轮278位按预期source_unverified停读，锚点／正文0，围栏59每轮不增，绑定／消息／目标／抓取／九类引用完全不变，原备份stat不变。它与后续在线通过的循环是两份独立证据，没有把停读写成正常同步成功。

## 脚本与实际命令

脚本均在 `backend-ts/scripts/verification/`：`sync-replay-support.mjs` 提供副本门禁、正式Worker与数据断言；`sync-recovery-replay.mjs` 执行新副本初次恢复和五次重开；`sync-recovery-repeat.mjs` 支持已有自有副本重复生命周期；`sync-recovery-pair-evidence.mjs` 对照制品来源；`sync-saved-metadata-counterexamples.mjs` 区分存档模式与传入executable的当前原生模式。

以下在 `backend-ts/` 执行；BACKUP是指定备份，CLI／OLD_CLI是正规配对的独立工件，ARTIFACT_ROOT显式指向同一任务工作树的独立构建根。正规prepareAliases使用账号和dbRoot只在内存核验，不打印配置／凭据，不修改真实配置。

```bash
node --check scripts/verification/sync-replay-support.mjs
node --check scripts/verification/sync-recovery-replay.mjs
node --check scripts/verification/sync-recovery-repeat.mjs
node --check scripts/verification/sync-recovery-pair-evidence.mjs
node --check scripts/verification/sync-saved-metadata-counterexamples.mjs
node scripts/verification/sync-recovery-pair-evidence.mjs --user-data="$COPY" --old-executable="$OLD_CLI" --executable="$CLI"
node scripts/verification/sync-recovery-replay.mjs --backup="$BACKUP" --user-data=/tmp/notalone-sync-recovery-online-final-20261107 --executable="$CLI" --artifact-root="$ARTIFACT_ROOT" --passes=5
node scripts/verification/sync-recovery-replay.mjs --backup="$BACKUP" --user-data=/tmp/notalone-sync-recovery-offline-20261107 --executable="$CLI" --artifact-root="$ARTIFACT_ROOT" --inject=false --expect=unavailable --passes=5
node scripts/verification/sync-saved-metadata-counterexamples.mjs --backup="$BACKUP" --user-data=/tmp/notalone-sync-recovery-saved-cases-20261107
node scripts/verification/sync-saved-metadata-counterexamples.mjs --backup="$BACKUP" --user-data=/tmp/notalone-sync-recovery-native-cases-20261107 --executable="$CLI" --artifact-root="$ARTIFACT_ROOT"
```

完整轮次聚合日志、每轮匿名JSON、失败副本及制品收据仅留本机，不进入Git。没有模型调用、媒体提取、记忆初始化或外部聊天发送。

## 数据影响与剩余风险

真实业务库零写入；真实15位围栏未操作；未点击修复同步、改主工作区源码、启动／重启／切换真实App、切换真实读取器、打包或push。副本接受新增消息、核对有界锚点、推进运行代次、原地恢复来源资格及整理既有空任务；不产生绑定或全量历史副本，不清理旧绑定消息。

在线五次重开及两组六维反例缺口已补齐。仍未覆盖真实NotAlone应用界面／真实库恢复、旧副本清理和3–7天观察；这些属于03／05／08。锚点有界，不能证明任意更早旧消息绝无改写；长期旧行状态变化仍依赖正式变化页，不能把localId续读写成全范围内容完整性证明。正式App的大库启动预算与用户体验另行验收。
