# 同步减负 04：source_proof 大库折叠与恢复验收

日期：2026-11-07。范围：指定 before43 备份的两份 schema45 衍生副本、正式 Worker 迁移46、独立v3读取器和正式同步服务。原备份、02原始副本、旧100误围栏失败现场、真实库及真实应用均不写入或切换。

## 迁移输入与逐联系人状态

原指定备份实际为3,199,328,256字节、schema42。复用02已经正式升级至45的两份衍生副本，各另克隆到新临时目录；只对新目录运行迁移。两份原45源文件的stat身份和修改时间前后不变。

| 输入场景 | 逐联系人折叠矩阵 | 旧fence→总needs | 身份授权token |
| --- | --- | --- | --- |
| 02在线恢复后的副本 | 278 范围匹配→ok；2 未核验绑定→needs_confirmation | 0→2 | 278可取得、2拒绝 |
| 保留59旧围栏的副本 | 219 范围匹配→ok；59 已围栏→needs_confirmation；2 未核验绑定→needs_confirmation | 59→61 | 278可取得、2拒绝 |

每份均280条source_proof。使用独立JS判据核对全部owner/contact：旧围栏保留；无围栏必须具备verified绑定、同会话／账号／代次与有效物理目标形状才为ok；缺失或不匹配则保守待确认。账号键、会话键、来源代次和tables_json逐行保留；迁移checked_at全部NULL，不补签一次当前来源核验。

总needs多出的2位在迁移前已经是unverified绑定、没有有效读取资格：它们由“隐含不可读”变成显式待确认，不是278有效范围新增误围栏。迁移没有重签授权，正式identity.eligibility在两份新库中均仍为278可取得token／2拒绝；其中旧59围栏对应的source_proof仍待确认，取得授权token不等于旧正文可直接使用，须经后续来源核验。

## 耗时、幂等和旧代码门禁

迁移SQL摘要：`e33e4fdd8faa21b915134caad278c226b0a9f66c2a04c4196f6f48ee0ba2f131`。

| 项目 | 0旧围栏输入 | 59旧围栏输入 |
| --- | --- | --- |
| 正式Worker打开、校验与45→46迁移总耗时 | 78,185 ms | 70,780 ms |
| 第二次正式打开，验证幂等 | 36,558 ms | 23,095 ms |
| 单独回滚试验：SQL执行 | 22 ms | 21 ms |
| 单独回滚试验：前quick_check／FK | 33,906 ms | 34,064 ms |
| 单独回滚试验：后integrity_check／FK | 57,652 ms | 58,571 ms |

单独SQL计时在可写副本的BEGIN IMMEDIATE事务内，使用正式迁移SQL、同样的notalone_sha256函数和foreign_keys／trusted_schema／synchronous／secure_delete／temp_store设置；检查后ROLLBACK，确认仍为45且无source_proof，再执行正式Worker升级。它是明确的回滚试验，不能把21–22ms写成生产打开总耗时，也没有跳过正式Worker校验。正式回放的打开等待最多10分钟、动作最多60秒，与App固定客户端等待预算不同。

新SQL修复了未完成旧删除目标的holderKeys与正式collect不一致的问题，专门contact／account用例已由主实现先红后绿。两份真实输入只读核对该分支均0行。此前旧摘要2683715e…下的顺序单份正式打开为10,847／12,283ms，重开2,267／2,346ms；这些历史记录保留，但不作最终新SQL证据。新SQL两份同时执行且与全量测试共享机器，完整校验明显更慢；调度和负载不相同，不能据此比较SQL优化或退化。

本轮78／70秒正式打开超过正常App固定60秒客户端预算，由验证脚本600秒等待容纳；本任务没有修改产品启动预算。真实App在同类负载下可能超时，必须作为交付风险保留，不能把验证脚本通过等同于真实App启动通过。

升级后source_proof取代history_continuity_fence／history_continuity_scope／history_guard_lease，表96→94。再次打开不重复迁移，46账本只有一条，全部来源状态／事实摘要不变；只推进存储运行代次。source_proof无guard_id／runtime_id等持久读者字段，进程守卫随运行生命周期重建。

旧02独立工作树仍保持registry45。它打开已升级的两个46副本均得到schema_too_new，拒绝前没有推进epoch或改写来源状态。另克隆迁移前45前像，旧代码可正常打开为45。回滚方式是停止新写者并恢复受控45前像，再用旧代码打开；不能让旧代码直接降级46库。本轮只在演练副本执行，未操作真实App或真实库。

## 数据处理影响

两份正式迁移前后绑定、消息、read_goal、sync_capture以及九类派生／引用行数逐项相等，没有微信读取、消息导入、模型调用、媒体提取或旧副本清理。

- 在线恢复输入：绑定831，消息407,271，read_goal12,524，sync_capture136,625。
- 旧围栏输入：绑定831，消息407,139，read_goal24,230，sync_capture141,085。
- 两者九类引用均为memory85、memory_candidate373、memory_citation932、memory_document13、memory_document_version13、reply_candidate33、reply_candidate_version33、reply_candidate_context16、reply_candidate_input_source773。

进行中的旧删除目标按正式迁移收敛到source_proof并失效旧runner；实际大库状态比对不代替该分支的专门合成用例。历史16／18迁移SQL不改写；已升级库依靠新的46账本和schema_too_new保护。

## 新表在线生命周期与反例

在已迁移、保留61条needs的演练副本上，用独立正规配对v3 SharedWechatClient和正式同步服务执行六生命周期（五次重开，含一次自有宿主／CLI SIGKILL）。基线分开计算：2位无有效资格的needs保留；278位有效范围恢复后为0。不能把非有效范围的2条删除以制造总数0。

旧摘要下先前首轮278/278、needs61→2；随后一轮199成功后1次native_unavailable、78次source_unverified，严格停止，但needs仍2、有效范围仍0，没有新增围栏。失败轮和JSON保留。当前新进程只读复核及全278范围当前元数据随后全部通过，未据瞬态错误猜测来源换代。

验证脚本按生产coordinator的1秒起指数退避，只对native_unavailable／source_unverified最多重试4次（1／2／4／8秒），每次失败单独记录编号前8位、错误码、needs前后和等待时间；真实来源变化码不重试。重试和最终成功分别计数，保留原失败轮，不将它覆盖为通过。新摘要最终六生命周期全部完成，退出状态0；这一组没有触发瞬态重试，错误和最终失败均0。

| 生命周期（0起） | 完成联系人 | 本轮needs／有效范围needs | 旧正文记录 | 耗时 |
| --- | --- | --- | --- | --- |
| 0 首次恢复 | 278／278 | 61→2／0 | 0 | 114,239 ms |
| 1 正常重开 | 278／278 | 2／0 | 0 | 185,785 ms |
| 2 硬中断 | 1位完成后中断 | 2／0 | 0 | 54,223 ms |
| 3 硬中断后重开 | 278／278 | 2／0 | 0 | 142,029 ms |
| 4 正常重开 | 278／278 | 2／0 | 0 | 89,746 ms |
| 5 正常重开 | 278／278 | 2／0 | 0 | 62,363 ms |

硬中断仅SIGKILL本脚本自己的宿主和1个独立CLI子进程，未操作真实应用或读取器；其后正式打开与全部278位续读成功。首次恢复读取2,682条有界锚点，核验413个表目标，页面返回136条新范围记录；下一轮返回7条，之后0条，六轮旧范围正文记录均0。回放期间微信有新消息，规范化消息407,139→407,276，增加137；这属于获准范围的正常增量读取，不是迁移导入。绑定始终831，九类引用逐项不变。read_goal24,230→11,582、sync_capture141,085→136,154是与02相同的既有goal-retention清理：删除没有capture_record、认证恢复或后继引用的旧空任务及旧空抓取；没有删除旧绑定副本或规范化消息。这是同步生命周期内的既有保留策略，不能与迁移本身的逐项不变混写。

最终可复用新表副本为`/private/tmp/notalone-sync-proof-final-fenced-20261107`；无同步改动的迁移对照为`/private/tmp/notalone-sync-proof-final-online-20261107`。全套在线日志在`/tmp/notalone-sync-proof-final-repeats-20261107.log`。

六维反例从原指定备份创建新副本并正式迁移至46，使用02同一验证脚本的表存在自适应路径。存档模式只注入已保存的正式元数据；当前原生模式先由正规读取器取得当前inspect／target并确认与正向控制一致，再改变账号／会话／代次／分片／表实例／文件身份中的一个维度。仅关闭可选resume/recover捷径以在元数据门禁截停，不改真实能力，不调用正文／锚点。每例需真正新增一个needs，绑定／消息／九类引用完全不变。

两组正向元数据控制均通过，存档模式6／6、当前原生元数据模式6／6，每例总needs61→62，绑定831、消息407,139和九类引用全部不变，正文及锚点方法调用0次。账号／会话／代次变化均为history_external_scope_changed；分片消失／表实例替换／文件身份变化均为history_source_continuity_unverified。原始备份stat身份和修改时间前后不变。成功后关闭并确认无打开句柄，再删除各自有反例数据副本，保留每例聚合JSON证据。

它们是渠道边界注入，不宣称实际切换了真实微信账号或替换真实文件；当前原生模式确实调用正规读取器获得当时元数据，但注入后的变化不是原生文件系统事件。日志分别位于`/tmp/notalone-sync-proof-final-saved-cases-20261107.log`与`/tmp/notalone-sync-proof-final-native-cases-20261107.log`，均于18:10:14完成；在线循环于18:12:20完成，随后未再启动大库验证。

## 可复用脚本与命令

均在backend-ts执行；SOURCE45为已关闭的自有45副本，OLD_SOURCE_ROOT为保留旧02源码的独立工作树，CLI为正规v3独立工件，ARTIFACT_ROOT为其显式构建根。输出目录必须全新，原始备份仍只能只读复制。

```bash
SOURCE45=/private/tmp/notalone-sync-recovery-online-final-20261107
FENCED_SOURCE45=/private/tmp/notalone-sync-recovery-offline-20261107
OLD_SOURCE_ROOT="$HOME/Documents/learn/NotAlone-sync-baseline"
ARTIFACT_ROOT="$HOME/Documents/learn/NotAlone-sync-simplification/local-tools/wx-cli/.notalone-builds"
CLI="$ARTIFACT_ROOT/sync-recovery-20261107-v3/bin/wechat-cli"
BACKUP="$HOME/Library/Application Support/NotAloneDesktop/backups/sqlite/before-migration-43-20261107.sqlite"
node scripts/verification/sync-source-proof-migration.mjs --source-user-data="$SOURCE45" --user-data=/tmp/notalone-sync-proof-final-online-20261107 --old-source-root="$OLD_SOURCE_ROOT" --rollback-user-data=/tmp/notalone-sync-proof-final-rollback-online-20261107
node scripts/verification/sync-source-proof-migration.mjs --source-user-data="$FENCED_SOURCE45" --user-data=/tmp/notalone-sync-proof-final-fenced-20261107 --old-source-root="$OLD_SOURCE_ROOT" --rollback-user-data=/tmp/notalone-sync-proof-final-rollback-fenced-20261107
node scripts/verification/sync-recovery-repeat.mjs --user-data=/private/tmp/notalone-sync-proof-final-fenced-20261107 --executable="$CLI" --artifact-root="$ARTIFACT_ROOT" --label=proof-retry-final --rounds=6 --transient-retries=4
node scripts/verification/sync-saved-metadata-counterexamples.mjs --backup="$BACKUP" --user-data=/tmp/notalone-sync-proof-final-saved-cases-20261107 --keep-case-copies=false
node scripts/verification/sync-saved-metadata-counterexamples.mjs --backup="$BACKUP" --user-data=/tmp/notalone-sync-proof-final-native-cases-20261107 --executable="$CLI" --artifact-root="$ARTIFACT_ROOT" --keep-case-copies=false
```

回放脚本保留45旧表能力，并按存在的表选择source_proof.needs_confirmation或旧fence；有效资格与总needs分别断言。日志只含聚合数字、固定错误码及必要时的编号前8位，不含姓名、正文、账号键或凭据。数据库、别名及收据只留本机，不进入Git。五个相关脚本均通过node --check；git diff --check通过。

## 普通60秒打开预算补充

所有大库回放及全量任务退出后，另从已关闭的02在线schema45副本建立全新副本，直接调用正式 `SqliteStorage.open`，不使用600秒回放等待器、不覆盖打开预算。最终摘要迁移至46在 **24,687ms** 内完成，低于默认60,000ms；来源证明仍为278条ok／2条needs，绑定831、消息407,271、read_goal12,524、sync_capture136,625及九类引用全部不变，源副本stat不变。

本机命令为 `node .scratch/sync-simplification/04-default-budget.mjs`。该端侧脚本的核心使用普通客户端：

```js
const copy = cloneReplayCopy(source45, freshUserData);
const [identity] = readQuery(copy.file, 'SELECT database_id,role FROM database_instance WHERE slot=1');
const storage = await SqliteStorage.open({
  userData: copy.userData, intent: 'open', role: identity.role,
  expectedDatabaseId: identity.database_id,
});
await storage.close();
```

脚本还核对全部聚合计数、源文件不变及没有打开句柄，再精确删除其自有一次性副本：3,199,328,256字节→0。原备份、正式最终副本、45前像及失败现场保留。历史源码临时导出目录／清单在全量后亦为0残留。

该结果补齐普通存储客户端的默认预算测试；并发验收时70.8／78.2秒的超预算记录仍保留，不能推导重负载下真实App启动必然成功。

## 尚未覆盖

真实NotAlone界面、真实库恢复、存量副本删除和3–7天观察仍属于03／05／08。新摘要正式Worker在并发I/O下超过App60秒预算的风险仍保留；普通客户端副本已在24.7秒内通过，但不能代替真实App的启动验收。没有启动／重启／切换任何真实应用或读取器、没有点击修复同步、没有打包或push。
