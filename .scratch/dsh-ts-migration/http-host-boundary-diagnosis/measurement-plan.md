# 同一 HTTP 请求的有限测量计划（未执行）

本计划只用于定位，不改变正式性能门槛或25/26状态。当前没有任何新流程；必须等 root 明确释放诊断窗口。App/微信由 root 独占，日常桌面只用 npm run dev。

## 冻结项

- 旧臂保持固定3c168296与已存在工具/依赖；新臂从1e90生产基线提取自有私有源码副本。提取是 Git 只读 archive，不写 index/worktree。复核实际加载入口与所有受影响源文件 SHA，再冻结插桩差异清单。
- 只复用已冻结合成 dump、现有 PG/Python/Node 和锁定依赖，不安装、不改原件、不碰其他业务库。输入 SHA 完整列在 evidence.json。
- 固定 contacts、sources、manual-header session-default 三路径，原请求方法/body/header/断言和持久化回读保持。并发1，各宿主各路径仍10暖机+30计分，所有失败及异常保留；不加空闲延迟，不扩预热、不新增最小宿主、不以最小结果 gate。
- 本轮仅私有源码副本拟加观察点，主树任何源文件均不修改；如需主树 patch，先报告依据、具体 patch、验证方案，待 root 授权。

## 一次有限流程

固定顺序：旧完整锚A → 新完整原观察器基线B → 新完整新增观察器C → 旧完整锚D。4宿主串行，每宿主120条原样本，总480；readiness与原有session回读单列，不偷算进480。不是正式40次启动或RSS矩阵。

总墙钟预算180秒，工作段150秒、收尾保留30秒。每宿主ready最多25秒；超时/启动失败/来源不匹配即保留失败并进入收尾，不自动补跑或换顺序。实验必须由一个有边界的后台驱动承担，root下一轮查日志；不得并行启动其他实验，不使用 clock.sleep 或重复无界轮询。这里只给预算，不提供已运行命令。

B 使用原 request→finish preload（含原 ALS 和原每请求 HTTP 行）。C 保留相同起止点及原观察器，并只在内存增加阶段数值。A/D 旧锚仅用于检查这一段机器/运行漂移，不替代正式统计规则。B/C 不同是观察干预，不能把 C 的绝对值直接当成未插桩生产性能。

## 第一轮观察点与预测

| span/点 | 拟插入位置 | 能判断的事项 |
| --- | --- | --- |
| ingress、handler.enter | 原 preload request 分支；host-plugin createServer 回调第一行 | 进入回调之前的调度/监听器间隔 |
| private.before/after | host-plugin:259 的 await 前后 | 第一次 false 分派与其续点总间隔 |
| auth.done、public.before/after | :275及:455前后 | 认证/其他分派与第二次 await；POST 此段包含完整 public handler，要用子段解释 |
| handoff.before/after、context.enter/exit | :527–534及ContactContext.handle | 联系人请求的移交与实际业务；GET无body读取，标N/A |
| body.before/after、scope.before/after、session.enter/exit | pure-ts-public-api:41,73,128–130 | session真正的body、手动范围核验与默认会话业务；不错误计到host-plugin.readBody |
| storage.enter/exit、config、acquire、begin/SET、operation、commit、release | host-storage:346–398及:303–345 | 每个事务用本请求内序号标识；session有两个事务，不合并丢失一个 |
| inspect.enter/exit、files.before/after、catalog.dispatch/result | :396–461 | 所有116文件身份核验和实时catalog均执行；明确并行重叠，不相加制造解释 |
| business await before/after | ContactContext固定业务与范围query；session实际事务 | 标签只记录静态阶段/序号，不存SQL、参数或结果；这是包含PG、解码及调度的总时长 |
| respond、stringify.before/after、end.return、finish | GET :246；public handler :35；原preload finish监听器 | 保持writeHead→stringify→end求值顺序，首次finish时间必须在原同步trace落盘前取值 |
| ready、task.refresh.begin/end、GC事件 | appReady:608–620；task-events:refresh；perf_hooks观察器 | 实际发生时间、reply状态枚举与启用布尔值；只读状态、不额外HTTP探测、不增加timer或启动后台功能 |

每请求先验证点的存在性与时间顺序，再按该路径相邻时点计算不重叠分段；嵌套span单独展示，绝不把storage、inspect、catalog、SQL等待重复相加。finish和end.return的实际先后照录，不以假设覆盖。所有时间使用同一进程单调时钟，GC startTime 只在确认时钟原点后对齐。

第一轮不 patch Client.query、Promise、pg回调/thenable或驱动parser；不修改固定依赖。PG解码、socket到readyForQuery、ready到await续点仍不能单独分离。如果主要差值落在query await，下一轮再提只针对已装载同一pg实例的同步事件观察或CPU profiler计划，另等root窗口，不自动扩实验。

## 控制观察器影响

- 沿用原诊断 ALS；不新增 async_hooks/ALS，不每SQL打印或写文件。轻量同步mark只写内存数字，request_id来自既有采样header。暖机也完整记录。
- 固定每请求最大256点、GC/后台事件总容量4096；溢出置unknown并保留已有数据，不丢慢样本或重跑。只存阶段枚举、相对时间、计数/布尔值，不存正文、owner/contact实体、SQL、认证header、环境值或文件路径。
- C内仅采样 ingress/finish 的进程cpuUsage/ELU差值与GC事件。它们包含共进程其他工作；不称单请求CPU。无新timer、无固定空闲、无暂停事件循环。
- 原HTTP行保持原监听器与原写入方式；新增阶段缓冲在全部固定请求与原读回结束后、清理宿主前一次写入私有输出。预设退出/信号处理需在失败路径保留缓冲，失败也进入分母。
- 输出B/C各路径全部样本与p50/p95差异、A/D旧锚漂移；不能用这四组建立新的正式门槛。若新增观察器或锚漂移与待解释差值同量级，阶段归因标unknown，保留本轮而不挑结果补跑。
- GC/任务重叠、进程CPU/ELU仅用于筛选下一假设；没有事件不证明没有其他调度/编译，单次相关不证明因果。第一轮没有CPU profiler、Debugger暂停、trace-opt或loader核心替换。

## 后续分支（均未授权执行）

1. 前置阶段短：排除其为主因，专注已定位的storage/query/finally阶段；不为省两个await改产品。
2. 业务已快而finish慢：检查保留协议的序列化/结束行为；不改统计起止点或删除错误检查。
3. 内部CPU/GC主导：用精确慢段安排一次私有合成CPU采样，绑定loaded script URL/摘要与采样时段，记录采样器影响，不把启动profile当HTTP profile。
4. 出现实际模块解析/编译信号：先核到具体loader函数与实际装载文件、版本/flags，再提对照；不由导入图推断JIT，不改DSH核心、不替换官方profile。

## 输出与收尾

原始/含路径日志只在本任务获准的私有子树中，目录0700、文件0600；只允许读取原先三个白名单入口和自有私有子树，不遍历邻居。公开仅脱敏摘要、完整失败/unknown、输入/补丁/输出SHA、准确的rows分母及manifest，不复制private内容。

只清理本次明确归属的4个宿主、自有_test库、连接和私有源码临时副本；不停止共享PG、不触碰root的App/微信实例。逐项核验退出、会话0、库不存在、源码/依赖/合成dump未改，记录未清理项；核验后归还窗口。全量测试、真实模型、正式96/40×60sRSS、外部消息、打包、远端和25/26签收都不在本有限流程内。
