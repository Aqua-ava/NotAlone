# 06 收尾：保留语义下失败族用例的判定（2026-11-08）

在保留语义恢复（`f687` 语义：成功带守卫租约保留通道+守卫条目；无守卫/失败/一次性租约按租约收尾）后，按决定逐例收敛。每例先判定是否在守真实安全性质；有安全意义的改为保留语义下的等价安全断言，不删弱；纯实现细节的才直接改。

## history-status-recertification（6 例，删除）
- 用例经 `fixture.statusRecertification` 写已被 ADR-177 退役删除的 `history_source_recertification` 表，属"退役对象本身"，不是被测安全性质。
- 处置：删除 `backend-ts/test/history-status-recertification.test.mjs` 与 `backend-ts/test/fixtures/history/status-recertification-registry.mjs`；旧表退役行为仍由 `sqlite-sync-retirement.test.mjs` 锚定（迁移清空、48版打开与回滚拒绝）。
- 已将此记入 06 工单 Comments（删除清单补遗）。

## shared-process-loss（9/9，1 例改断言）
- 例：`共享读取器停止后的旧渠道仍须核对物理目标，实际变化继续围栏`——期望 `history_source_changed`，实际 `history_source_continuity_unverified`。
- 判定：**断言过时（上一轮会话押注的映射错误）**。来源身份层（`accountKey`/`source_generation`）变化才应抛 `history_source_changed`（同套件另有用例覆盖）；本例仅物理表实例不同，属 continuity 事实核验未过（T02 围栏原因字段记录），与 06 保存点断言一致。安全性质未弱：两种码都围栏且停读，用例的"必须围栏并停读"断言保留。

## snapshot-follow（6/6，2 例改断言）
1. `每次独占读取结束即释放原生通道和守卫…` → 改为 `成功同步轮保留已停车守卫并复用通道对象，两位联系人两轮不遗留未收编通道`。
   - 06 版守的是"每租约释放"实现细节；保留语义下的等价安全性质是"不遗留持有原生选择的空闲租约/未收编通道"：a→b→a→b 三次换主每次先停车上一位 owner 的选择（`parks===3`）；旧通道对象被换出时必须关闭、轮内仍在保留表的通道不得关闭（closed profile `[1,1,0,0]`）；任意 guardId 的 `guardCheck` 必须为 false。
2. `旧读取器没有持久历史检查点时，同租约完成33页并在两轮继续增量` → 恢复基线形态 `旧读取器缺少持久历史检查点时交回原首次路径并在同一租约扫完33页`。
   - 安全性质：非持久读取器不得进入 32 页交接切片（持久能力齐备才允许有界交接）；页须全部交回首次协调器续办，普通游标在同一租约内保留到终页，页数恰 33、34 条消息可读。06 版把交接写成同租约直推进而基线/当前实现是首次协调器接力——按实现语义取等价安全断言。

## partition-growth（8/8，2 例改断言）
3. `新增表目标尚无检查点就中断时，仍能从已核验旧分片的恢复点接续`——06 版用 `pageHook` 注入 `history_native_timeout` 表达"中断"；保留语义（非持久读取器）不进交接切片，page 注入不可达。等价中断表达式改为**进程重启**（close+重开服务），安全性质不变：重启不得丢失已核验恢复点，仍以 `resume-v1` 接续、两位表消息都可读、resumes 每次 cursor 均为 resume-v1。
4. `已接受单分片历史遇到安全表增长时从原游标建立新目标，只收新表消息`——06 版期待 同租约 growth 直达 complete；保留语义下 growth 的读取交回首次历史（定向唤醒 [contactId]，phase running），随后一轮从原游标（resume-v1）建立新目标只收新表消息并达 complete，两表消息 2 条。安全性质（新表消息不丢、旧分片恢复点保持、不同来源围栏）保留。

## first-history-coordinator（1 例，真回归，改代码不弱断言）
- 例：`未选和读取关闭时零渠道IO…` 断言 `closes===1`（基线逐字相同）。该用例 `continuity:'source-1'` 非 normal-use：armGuard 无 proof 且通道无 guardSession 时不构建任何保留条目，租约结束应关闭一次性通道（基线 finally `else if(!retained)await closeChannel()`）。
- 根因：恢复实现把"无守卫的成功租约"也登记进保留表且不关通道（真回归）。修复：`cleanup` 中只有 `guardId` 成立的成功租约保留条目；无守卫成功租约照常关闭通道（`service.ts` 保留分支加 `&&guardId`，新增 `else if(successful&&!guardId) await closeChannel()`）。修复后 21/21，且 guard 40/40、prep 7/7、s-p-l 9/9 复跑全绿。

## cutover-retirement（1 例，过时断言，main 同样失败）
- 例：`13偏好、15纠错诊断、17真实媒体与回复入口在SQLite宿主保持不可用声明` 要求源码字面包含 `mediaExtraction: 'unavailable'`；现行宿主按 `originalImages` 条件声明 `mediaExtraction: originalImages?'typescript':'unavailable'`（与 main 一致，main 同例即失败）——静态字面扫描过时，且该能力按图片能力条件启用早于 06 的语义演进。
- 处置：断言改为核验现行条件声明字面（关闭能力时回落 `unavailable`），其余 6 项不可用声明逐字保留；安全性质（未开放入口必须不可用）不弱。修复后 8/8。

## 复跑证据
- 套件绿色复跑（2026-11-08）：snapshot-follow 6/6、partition-growth 8/8、shared-process-loss 9/9、first-history-coordinator 21/21、cutover-retirement 8/8、guard 40/40、source-preparation 7/7、transient-guard-recovery 6/6。
- 修复前诊断与原始失败摘录存 `~/.local/state/notalone/diagnostics/sync-simplification-remaining-20261107/`（session3-external-diagnosis.md、/tmp/wt06-sf.log、/tmp/wt06-pg.log）。
