# 任务19 D5/D6 证据闭包最终独立复核

结论：可以支持原根按既有26原子验收范围签收19。原矩阵24项分级证据保持冻结，D5/D6新增执行证据补足原两项缺证；本次未发现产品缺陷或新增阻塞项。不等于本轮26项全部重跑，也不执行票状态/原blocked目标变更。

## D5结论与早期发现的处置

- 详见findings.md和frozen-facts.json：code7、自然heartbeat跨3秒退避、4748ms后新PID、原metadata cursor接续、ID2重放+ID3唯一、同owner/contact/binding、授权/baseline保持、模型0均有冻结原始记录支持。
- D5原probe没有显式assert第二流metadata cursor；本审查直接核同轮raw命令及原fixture唯一事件顺序，第二流确携第一代最后global-1-outside。属于事后只读事实核验，未改原采集/断言，也没有新测试。
- E1事实保留：两case的wechat_sync_exclusion均空。closure-addendum.json:94–99、176–181明确direct_scope为selected/new-only且未布置非空排除，:199–235具名组合B3–B6/E2的真实PG/官方scope/109旧证据；没有声称本probe实测非空排除。
- 原矩阵已接受B3/B4自动全部范围、B5/B6撤销删除排除、E2失效消费，当前相同模块/存储接缝没有变化（sync-scope.ts:112–125）；无需将每一授权维度重复乘以每一种故障。故E1是本包直测边界，经闭包明确组合后不再构成19新增阻塞。
- E2仅为D5 handoff:22少列一个夹具--mode===sessions收紧，真实两代argv都为sessions；本报告保留这一不阻断记录精度问题。

## D6直接核对

- 最终result SHA为8fedbbc4cef8119cc61b7d5f855d5693300353df2b6ad00eab28bb186706d9de；latest artifact为f72622aa81cdbbf97ae9d1879db342247845be692ddda2d25071da078a1bf30c，与根给定摘要及闭包一致。
- launcher-helper.mjs:4–7调用真实launchDsh，probe.mjs:79–85先固化1条消息/来源/created回执/游标/派生收据与无活动模型journal，非空库。
- :86仅向身份核验成功的helper49925发SIGKILL；:88–93观察DSH49927、Legacy49949与原CLI自然消失，info/profile/socket消失而旧锁保留、journal.host=null；原插件父丢失/关闭顺序见host-plugin.ts:44–58、103–119。
- :95–98用同一config文件和同库/env/business/info/ModelHost路径启动helper50078→DSH50080/Legacy50092，lock nonce自然更换，没有写锁/info/journal/DB重置。恢复窗口只有GET（startHelper含runtime/status，主等待为sync/status），没有二次confirm/enable/check/retry。
- 原始命令记录第二DSH子进程50133携--cursor incremental-2读取friend-a；记录的自动恢复耗时4657ms，未造停机新消息。
- :102–108与原始before/after快照交叉核：原消息对象及UUID完全同，原source/created record按record_id保留、原派生receipt完全同；绑定/baseline/scope/开关及cursor保持。新增1个source同owner/contact/message/binding，并有payload持久结果对应的message_reused；规范消息仍1、source共2、模型/任务/出站/reply计数均0。
- 第2轮原RED在same_path_restart断言source_ref_count=1失败；原store-write.ts:22–27按observation追加来源、按稳定message身份复用，规范消息/UUID原本仍1。最终探针只放宽错误来源计数并加强原来源/record_id/新增reused追溯/派生收据及退出等待，产品源码未改。更早PGUSER遗漏、exec身份采样失败也在三份原RED记录中保留。
- 最终probe stdout为PASS、stderr空；最终正常shutdown后全部自有进程gone，emergency_owned_process_cleanup=false，库/fixture/info/锁/profile/socket清理，共享PG保留；展开源与226120字节自有native缓存的后续清理记录有双SHA。早期失败轮曾用自有紧急收尾，未冒称所有历史轮都无紧急清理。

## 独立身份与覆盖核验

- D5 30条raw/shared全匹配，两轮归档各734文件核hash；D6 18对raw/share、9 raw-only、3 share-only全匹配，899文件的before/frozen/after聚合SHA及归档/当前文件全吻合。仅读归档，没有提取/执行；完整结果见sha-review.json、d6-sha-review.json。
- D6 889个tracked输入逐字同固定43ae，另10个输入不在该commit（4个测试/夹具、6个egg-info）；当前899均同。43ae→256fecc1提交仅离线工具/测试及记录，运行源码无变；身份用于界定证据适用范围，没有代替执行。
- D6官方4份源及3份installed文件独立复算全同DSH0.2.1-rc.2/687f282；D5官方5份同。两套最终分享文件在复核末仍未漂移。
- 原coverage-matrix.json与旧handoff摘要仍等于closure记录；26行里只有D5/D6为旧evidence_gap，其余24为具名分级证据，闭包没有把它们改写成当前直测PASS。
- 只读投影d6-frozen-facts.json保存过程PID、退出/恢复状态、原行与新来源追溯核验；原敏感路径及合成原记录仍在仓外，报告只用别名。

边界：D6证明后端helper父丢失，不等于真实Electron/App崩溃；D5/D6直测selected/new-only且排除为空。全部私聊/非空排除/109为旧证据组合；不签20历史追赶、21 OCR、17全部删除产品闭环或整体迁移。清理只审既有记录，不新查DB/进程。本次零测试/HTTP/DB/网络/App/微信/模型，所有写入仅本审查目录。
