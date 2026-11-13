# 会话进度（2026-11-08，接手 codex 会话 01a1b591 收尾）
工作树 /Users/local-user/Documents/learn/NotAlone-sync-remaining，分支 codex/sync-simplification-remaining；全部改动未提交（06 未达整训前不提交半截）。
- 已修复（本会话，全部有仓库回归且复跑确认绿）：
  1. holders.ts releasedOnFailure：close 失败但读者已真实排空时移除 holder（test/sqlite-history-guard.test.mjs 末尾 2 用例，guard 40/40）。
  2. service.ts prepareSource/waitForDrainedReader：done 已结束但 close 失败 → 重试真实排空（诊断 six-holder-failure-diagnostic.mjs 2/2 绿）。
  3. deletion.ts:53 collect：等价表 sqlite_schema 守卫（46 库不再 storage_invalid；restart 2/2 绿）。
  4. service.ts syncIncremental ~421-431：无 resumeTarget 的旧读取器不再提前 return，本租约扫完终页续增量（ADR-177 第三句）。⚠块结构必须含 handoff try/catch 与闭合 }。
  5. actions.ts resumeCheckpoint ~161-181：增量行含 invalidated/runtime_revalidated 仍为合法恢复点 + ORDER BY (kind='incremental') DESC（durable-resume 3/3）。
- 待修复簇（新深块，需独立会话）：test/sqlite-wechat-history-channel.test.mjs 单跑 ~14 失败 + 1 例>30s 挂死（『共享通道park失败确认原进程停止后，宿主重试只续清原资源』）。失败名均不在两基线清单（diagnostics/…/final-*-failures.json），属 06 改写共享通道/park/图片隔离族语义后果；第一例根因是 fixture 进程账本 channels 2≠1（test:131）；对照'对照'组是故意断言旧行为的对照组，按 ADR-177 逐一判定。此前自跑全量也卡在同一套件（死等）。
- 指标：history/sqlite 36 文件/4604 行（基线62/6560；目标≤4592 差12行=29.82%；本会话净增约17行为五处语义修复，未压行，是否达标留待复查）。backendSrcTs 310/37449。tsc 通过。
- 终验队列（channel 收敛后）：①channel 单套 exit 0 →②全量 npm test 对照基线失败零新增 →③six-copy-sync.mjs 47 库副本两轮 16/16 回放（脚本与 replica 在 diagnostics，真库只读防护已内置）→④隔离开发 App（diagnostics/desktop-06-synthetic + synthetic.env；禁打包；Computer Use 界面核验）→⑤closeout：docs/verification/sync-simplification-06-retirement-20261107.md METRICS/BACKEND_FULL 占位 + 收尾修复段 →⑥按主题分块提交（Conventional 中文无署名）。
- 已知放行项：startup-host『manual正式profile…』双基线命中允许失败（该文件现 6/7，唯一红即它）。
- 乌龙记录：service.ts 一度被误删 handoff 块，已复原并复验 3/3；worker.ts 曾临时加 stderr 诊断已原文还原。
