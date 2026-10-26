# 完整宿主 HTTP 执行边界：静态诊断

2026-10-26。当前只完成静态分析与测量计划，没有新 HTTP、PG、测试、类型检查、宿主或 profiler 运行。性能根因仍未知，25 保持 claimed / not approved，26 保持 open。本目录不批准整体迁移或性能。

## 证据和约束

- 生产基线：`1e90d9edde3a5c3ac0de08c018149dd79bbebdfc`；整理证据时 HEAD：`7997f61b36ebae3dcb2c128637ade34bb0fb162c`。已静态核对相关生产文件与基线无差异；复验前仍需核对源文件 SHA。
- 已应用 diagnosing-bugs 和 codebase-design。因明确的只读限制，本轮跳过重新运行反馈回路，继承已有 RED，不把它描述为本会话复现。测量的是实际请求跨越的 Interface 与内部 Seam，不新增产品接口。
- 已核对 workflow、engineering、domain、issue-tracker、triage-labels、CONTEXT，以及架构索引、ADR-006/009 的修订指针、ADR-102/104 和当前领域/隐私的适用段落。历史文档的“未实现”描述不覆盖当前代码与真实运行证据。
- 仅新增本目录公开证据；不改源码、受保护的三份用户文件、原始资料、模型、预算、依赖、Git index 或提交。没有 App/微信操作、子 Agent 或新 chat。日常桌面仍仅 `npm run dev`。

## 沿用的失败信号

已有完整/最小反事实共320成功样本；完整与最小新臂 contacts p50 为4.344709/1.459375ms，sources 为2.187750/1.780292ms。两者复用 ContactContext、HostStorage 与 stringify，但省略的认证、移交、取消、恢复、后台及装配很多，因此差值不等于 DSH 开销。原 hosts.sample_count=120 与实际每宿主80行不一致，沿用独立按 rows 计数的更正，不修改原件。

已有 H1 空闲2秒的480样本与 H2 row-text 的480样本都没有支持修复。H2 安全11项通过、微测160样本不证明收益；准备错误和无效尝试留在原证据中。SQL 同 psycopg 六步约0.453ms、目录实际4 contacts/0 sources，以及独立完整业务微测约1.3ms，只能缩小问题，不能解释当前完整宿主的剩余差值。不同运行、不同观察器的数值不能相加或拼成同一测量。前作者冻结交接另说明，早期清理的部分临时宿主原始输出只剩脱敏副本及 rawSHA，不能声称全时期原件齐全；本轮没有恢复或改写它们。

## 已核实的执行路径

| 阶段 | 精确源码位置 | 静态事实及其限度 |
| --- | --- | --- |
| ingress 与总计时 | continuation/http-production-instrumentation/perf-preload.mjs:45–57 | 在 request 事件进入前开始，到 finish 记录；每请求已存在一个诊断 ALS.run。finish 计时取值之后才同步写原 HTTP 行。不能据此证明产品 DSH 的 ALS 开销。 |
| 前置私有分派 | backend-ts/src/host-plugin.ts:259；skill-host.ts:87–89 | 无条件 await privateHttp；目标两个 GET 在 URL/path 判断后 async false；没有该分支上的 DB/file/model I/O。await 数量不是耗时证据。 |
| 认证及分派 | host-plugin.ts:260–275,294–307,424–455 | 原始 header 及 timingSafeEqual 核验后经过其他路由判断；两 GET 又 await handlePublic。不得删认证来制造收益。 |
| 第二次分派 | host-reply.ts:367；pure-ts-public-api.ts:31–34 | 两 GET 立即 async false；session-default 在此进入真正业务，不能按 GET 的区间解释 POST。 |
| 联系人移交 | host-plugin.ts:525–534；contact-handoff.ts:20–28 | enter/断言/finish 包含 pending Promise 与 revision 核验；没有等价的请求级 SQL 移交。最小宿主未执行这些步骤。 |
| 业务与存储 | contact-context.ts:22–57；host-storage.ts:275–280,303–398 | 两 GET 均 businessTransaction，普通 BEGIN；配置、租约、BEGIN/SET、fresh inspect、业务、COMMIT 和 finally 的释放都在请求关键路径。不能把 COMMIT 当作完整 handle 返回点。 |
| fresh 文件与 catalog | host-storage.ts:401–429,429–461 | 每操作核验目录与每个文件身份，身份相同才复用摘要；catalog 与文件核验重叠，不能把子段简单相加。不得缓存旧 ready 或省实时检查。 |
| session body 与事务 | pure-ts-public-api.ts:39–41,73,128–130；assistant-discussion-service.ts:137–143 | 固定手动 header 路径有独立范围复验和默认 session 事务；body 在 public handler 读取，不是 host-plugin.readBody。 |
| JSON 与 finish | host-plugin.ts:246；host-json.ts:12–18 | GET 先 writeHead，再 BigInt 安全 stringify，再 end；session 有独立 respond。需保留求值和写入顺序。 |
| 实际后台候选 | host-plugin.ts:608–620；pure-ts-task-events.ts:29–35 | appReady 回调内启动 taskEvents；立即刷新及完成后1秒定时。replyStatus/同步账号的已有推导不等于此轮实际状态，必须记录 ready/tick 时刻。 |

## 按优先级排列的可证伪假设

1. **前置分派或 await 续点占用主要差值**。若成立，同一慢请求的 ingress→context.enter（POST 为 public dispatch→业务入口）应占据毫秒级总时长；若两个 await 及认证/移交全部明显小于总差值，则排除它们作为主要原因。保持所有行为，只增加时钟。
2. **同样业务源码在完整宿主中花更多时间于存储或恢复续点**。若成立，差值会集中在配置/连接、inspect、业务 query await、COMMIT 后释放之一；若 context 本身已接近既有最小记录，转向外层。query await 包含 SQL、协议、解码及续点，第一轮不能拆出纯 PG 解码或微任务排队。
3. **GC 或实际后台回调与慢请求重叠**。若成立，慢请求与有时间戳的 GC/刷新段相交，并出现进程 CPU/ELU 的对应变化；只出现一个未重叠 timer 或无可观测事件不足以支持。相关性只能选择下一项因果对照，不能直接宣布根因。
4. **JSON、响应结束或既有观察器主导差值**。若成立，业务返回→stringify/end/finish 占据差值，或新增观察臂相对未插桩对照明显变慢；若这些段均短且观察扰动小，则降低优先级。进程 CPU 与 ELU 含同时运行工作，不能冒充单请求纯 CPU。
5. **模块解析、编译/JIT 或初始化后效应**。完整启动安装了真实解析拦截，但目标路径未见动态加载的调用证据。若后续观察显示慢阶段发生 resolve/import/编译或反优化，才做对应有限对照；静态 import 图大小、存在 ALS、一次全程 CPU profile 都不能证明它。

## loader 的精确静态核对

`launch.ts:145–162` 由官方 dsh bin/profile 启动。dsh-app-boot/lib/index.js:4127–4134 把绝对插件路径转为 file URL，交给已有内部 ModuleLoader.import；cordis-plugin-loader/lib/index.js:214–227 使用内部 loader 或原生 import。所读路径未见 tsx/jiti/esbuild 转译调用，不据此宣称已经测得 V8 编译行为。

app-boot 的 PluginPackages 构造器（:3497–3507）安装 runtime interception；在当前 Node24 分支，:1922–1936 包装 ESM resolveSync，:2045 包装 CJS _resolveFilename。不能说“没有 loader 拦截”，也不能说拦截在每个 HTTP 上执行。当前三路径的本地调用链只有 relationship-overview 的分支存在 contact-overview 动态 import，固定 workload 没走该分支。实际已装载文件/优化状态仍未知，必要时另提 inspector 观察计划，不改包核心。

## 数据、验证和剩余工作

只读取仓库源码、已装依赖源码及公开合成证据，未打开任何授权外资料或凭据，也未读取私有原始日志。实际执行均为静态 `rg/sed/cat`、Git 只读状态/版本/差异摘要、JSON/哈希整理和本目录写入；没有项目验证命令。静态定位时的两处错误候选文件名及一次 shell glob 无匹配已记录在 evidence.json，不是产品或实验失败。

下一步见 measurement-plan.md，尚未获实验窗口。新测量结果、真实根因、观察器代价、实际 ready/GC/tick 重叠、PG 解码/续点分离以及最终正式40次启动×60秒RSS、96条回复与 App 验收都未完成。继承输入和本次输出的精确 SHA 见 evidence.json、staging-manifest.json 与 SHA256SUMS。
