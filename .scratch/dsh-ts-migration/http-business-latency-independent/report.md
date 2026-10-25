# 三个固定 HTTP 的独立业务 SQL 诊断

2026-10-26。结论限于固定合成材料、一次有限 SQL 流程及已有 HTTP 记录；目标 25 未通过，26 未开始，记忆语义 deferred，费用豁免不豁免 HTTP 性能。

## 可核对结论

1. `sources` 确有业务层增量：三次范围版本查询＋联系人和 owner 两次事务锁；目录主 SELECT 与固定旧臂等价。本次五步保护占六步 SQL 等待的逐样本比例中位数 **84.62%**，但六步合计仅 **0.452749 ms**。这证明保护有成本，不能解释已有 HTTP 约 **2.961291 ms** 的全部增量，亦不能从跨运行数值直接算因果占比。
2. `contacts` 主 SQL 并非逐字等价：新增同范围 observation 存在性分支，并在 PG 构造 `data_status` JSON；有限测量旧／新 **0.109146／0.132583 ms**。固定夹具里新增 observation 分支 **Actual Loops=0**，目前不能将其判为 HTTP 主因或据此撤销同范围保护。
3. `session-default` 在固定 workload 带手动联系人 header。新公开适配先单独读事务核验手动确认，再进写事务；旧臂在同一事务检查确认并 upsert。其两事务不是模型、记忆或 DSH 会话计算产生。
4. `sources` 旧新各 30 个计分 HTTP 响应独立匹配 `{"sources":[]}` 的摘要，有限 SQL 也全部返回 0 行；不存在“大量来源结果／正文序列化”这一组证据。其完整目录 JOIN 的 background_task 节点根本未执行。
5. 未运行任何新 HTTP 或正式评测；不能宣布完整根因已闭环、HTTP 达标或原 Bug 已修复。

## 来源与方法

- HEAD 为 `3a550efb6f59342b487b212c65b5819fa7b1425c`。固定旧臂 `3c168296e9e8edaa43b8b323ff693e790e709069`；白名单旧归档的五个关键 Python 文件逐字匹配该提交，新六个业务文件 SHA256 匹配 `continuation/http-production-03.json`，测量前后保持一致。
- 旧代码以下行号均指固定旧提交：`backend/src/notalone/...`，不是假设当前 Python 文件仍相同。
- 原 HTTP 依据为 `http-latency-regression/continuation/http-production-03.json`：10 预热＋30 计分／路径／臂、单并发；独立从 rows 重算中位数，与既有 summary 一致。未重算或替换冻结协议的 CI／统计规则。
- 较早 `sql-profile-after-new-trace.jsonl` 启用了 CPU profiler，且 HostStorage WIP 较旧；只用来核对调用形状和结果行数，不和 production-03 拼成一次测量。`storage_times` 中 inspect／withClient／内部 SQL 重叠，不可相加。
- 先静态只读；root 与主作者明确让出窗口后，仅一次后台 `measure-sql.py`。由冻结 `plan.python` 执行，使用 root 指定现有 pg_restore，固定 dump 恢复至自有随机 `_test` 库；总流程 **0.352 秒**，共保留 **120 条**样本（含预热）和 5 份实际执行计划。
- sources 保留普通 BEGIN、原三个 SET LOCAL、六步原序、三次版本比较和 COMMIT；实际隔离为 read committed。contacts 旧新交替，同一 psycopg Adapter、`prepare=False`；Python 时间含本机往返和解码，**不代表 Node pg 的专属解码时间**。
- 本库前后其他活动连接均为 0；root 与主作者均声明暂停诊断。记录 loadavg，但未枚举全机／用户进程，系统或跨库噪声仍未知。固定材料本身很小，不将此结果外推到真实大资料。

## 原 HTTP 失败信号（既有记录）

| 路径 | 旧 p50 ms | 新 p50 ms | p50 比 | p95 比 |
| --- | ---: | ---: | ---: | ---: |
| GET /api/contacts | 1.795021 | 3.431771 | 1.911828 | 2.059268 |
| GET /api/contacts/{contact}/sources | 1.221563 | 4.182854 | 3.424183 | 3.595561 |
| POST /api/contacts/{contact}/assistant-session/default | 2.406896 | 2.970167 | 1.234024 | 1.422519 |

既有门槛 p50≤1.15、p95≤1.25 均未满足；本任务不赋予这些局部记录正式资格。

## 逐路径核对

### contacts

- 新 `backend-ts/src/contact-context.ts:27`：一个目录 SQL，两个计数包装进 `json_build_object`；消息有效来源片段在 `:14–17`。
- 旧 `persistence/contact_directory.py:27–73`：同 owner、同创建顺序，返回 id/name/两个独立 count，Python 再装 DTO；来源片段 `persistence/message_sources.py:45–73` 的 observation 分支仅检查非空。
- 新增 observation EXISTS 校验 owner/contact/id；初始 FK 仅引用 observation id（`backend/database/migrations/021_message_source_ref.sql:37–42`），不能仅凭 FK 存在就建议取消范围校验。
- 本次两臂每次均 4 行、规范化摘要完全相同；原 HTTP 计分摘要也一致。新查询返回 3 列（含 JSON），旧为 4 列。实际线传字节／Node JSON 解码、stringify 尚未分段观察。
- EXPLAIN：旧规划／执行 **0.074／0.019 ms**，新 **0.085／0.027 ms**；均 25 shared hits、0 reads。两臂 message 索引节点每次循环实际 0 行；新 observation 额外 SubPlan 循环 0 次。

### sources

- 新 `contact-context.ts:33–42,56`：revision-before → contact-lock → owner-lock → revision-after-lock → sources-select → revision-after-result。
- revision SQL 在 `:68–79`，包括联系人 xmin、bindings、owner accounts、同步开关／范围／历史授权／排除项和来源 xmin；其中多个集合是 owner 范围，并非只查一个 source。
- 旧 `persistence/source_tasks.py:23–46` 和 `server/app.py:1650–1675`：一次目录 SQL，无上述五步。新旧目录 JOIN、范围条件、删除状态 COALESCE、排序及 8 个返回字段一致；新直接返回行对象，旧 zip 成 dict 并转 UUID。

| 原序阶段 | 本次 p50 ms |
| --- | ---: |
| 锁前 revision | 0.117271 |
| 联系人锁 | 0.022354 |
| owner 锁 | 0.017001 |
| 锁后 revision | 0.111000 |
| 目录 SELECT | 0.069709 |
| 结果后 revision | 0.113396 |
| 每样本六步总和的 p50 | 0.452749 |

表中各阶段中位数不能直接相加替代逐样本总和。锁没有被注入竞争，本次不能估计真实锁争用等待。

- 新旧目录 EXPLAIN 的节点／索引路径相同，均 0 行、2 shared hits、0 reads，执行均 **0.004 ms**；background_task 的内侧索引扫描 Actual Loops=0。
- scopeRevision 计划返回 1 行，13 shared hits、0 reads，执行 **0.023 ms**；读取 7 个子计划，空范围仍有规划、往返、JSON 聚合与解码成本。
- 较早 Node profile 各 30 计分样本：contacts 2 个 business_sql，sources 7 个，含每事务一次 baselineObject 检查；sources 业务行数形状恒为 `[0,1,1,1,1,0,1]`。该 profile 的 sources 业务 SQL 累计 p50 **0.6055 ms**、总 HTTP **2.2611 ms**，反而低于同 profile contacts 的 **4.1139 ms**，说明仅凭调用次数不能解释各运行的全部差异。

### session-default

- 固定 workload 是 POST、空对象、手动联系人 header，不是无 header 的默认路径。
- 新 `pure-ts-public-api.ts:128–130` → `pure-ts-reply-scope.ts:33–42`：单独 businessReadTransaction 检查手动确认；然后 `assistant-discussion-service.ts:137–143,324–333` 经 owner 锁、联系人检查、确认复验和 upsert。
- 实际 resolveBinding 装配在 `host-reply.ts:198–202`，读 `pure-ts-reply-scope.ts:15–31`，不能只看 service 的备用实现判断调用数。
- 旧 `persistence/assistant_session_store.py:566–570,596–605`：单一事务 owner 锁＋`_active_binding`（`:67–93`）＋同一默认会话 upsert。新旧 upsert 的冲突键／条件／不改 updated_at／返回 id 相同。
- 旧新响应内 session_id 各自稳定、彼此不同；来自隔离数据库生成值，不能据逐字 hash 不同判业务不等价。本次未另测 session，未扩大测量窗口。

## HTTP 与序列化的实际差异

- 新 contacts/sources 共用 `host-plugin.ts:245–275` 的认证和 `:525–534` 的 ContactHandoff 生命周期，均在本进程直接进入 ContactContext；纯 TS public handler 对这两个路径在 `pure-ts-public-api.ts:31–34` 立即返回 false。没有该两路径特有的额外 Python HTTP 跳转。
- 新统一响应 `host-plugin.ts:246` 用 `host-json.ts:12–18` 的 BigInt replacer；旧 `server/app.py:3981–3999` 用紧凑 UTF-8 JSON 并显式 Content-Length，`:3509–3520` 写 socket。新 Content-Length／chunked 的实际线传形态没有采集，不能仅凭 writeHead 源码断言。
- HTTP ingress：新 preload 在 Node request 事件计时，旧 sitecustomize 在请求头解析完成后重置时钟；终点分别为 finish 和 handle_one_request 返回。两者不是同一函数内部边界，已有协议按此比较，本任务不更改。
- production-03 客户端减服务器时间的中位数：contacts 旧／新 **0.2037／0.1808 ms**，sources **0.1901／0.2710 ms**，session **0.2250／0.2272 ms**。这些剩余量含边界与调度差异，不能当成纯网络或序列化时间；其差值也不直接改变服务器 p50 指标。

### 未解释增量的更小静态路径

- **DSH 包装**：实际 `launch.ts:149–151` 使用 `profile/host.patch.yml` 装配 `host-plugin.ts`，不是早期 validation profile。`host-plugin.ts:54,245` 在 apply 中创建原生 Node HTTP server；`host-reply.ts:367` 的 handlePublic 直接返回 publicApi.handle。此三个固定路径均未调用 `ctx.agents`／llm／tools，也未进入 `host-reply.ts:135–143` 的生成 execute 包装。框架共进程带来的调度／GC／其他任务竞争仍可能存在，不能由这条静态路径排除。
- **Node pg 解码**：锁定 pg 8.16.3、pg-types 2.2.0、pg-protocol 1.16.1。`pg/lib/client.js:374–376` → `query.js:82–99` → `result.js:63–75,94–102`，逐行逐列调用 parser；pg-types 的 `lib/textParsers.js:202–203` 为 JSON／JSONB 注册 JSON.parse。协议 parser `dist/parser.js:228–237` 先把每个非空字段读成字符串。
- **范围 JSON 次数**：每个 scopeRevision 固定包含 6 个非空 JSONB 聚合字段，三次潜在 **18 次 JSON.parse＋3 次 JSON.stringify**（ContactContext `:68–79`）；contacts 的 4 行则潜在 4 次 data_status JSON.parse。sources 最终目录空，但范围元数据仍需解码／重编码。未发现该路径配置专用 JSON parser；这些次数由源码推断，尚未用 Node 计数实测。
- **HostStorage 查询包装**：读取时的 WIP `host-storage.ts:18–84` 对业务事务安装 trackQueryFailures，包装 `_pulseQueryQueue`、Query.handleError／end cleanup，并为 promise 追加 rejection 链；`:87–120` 为每次业务连接租约创建未连接的 retired Client 与 Proxy。它们是 Python 直接 SQL 流程未包含的实际代码，且有关闭、错误归类和不复用污染连接的保护目的，不能用旁路删除来证明 gate。
- **新鲜 catalog 解码**：读取时 WIP 的 `host-storage.ts:443–461` 将 catalog／columns／constraints 聚合为 JSONB envelope，再在 JS 建 Map／比较；与 sources 的范围 JSON 是两个独立载荷。较早 profile 有 pg data-row、UTF-8、GC、async context 栈，但不能按全运行采样自耗时拆成每 HTTP 的确定归因。
- **AsyncLocal**：产品中的 requestScope 在 `pure-ts-reply-scope.ts:8–12`；固定 session 的手动分支进入一次，contacts/sources 不进入。回复来源缓存的 `reply-source-guards.ts:31` 不在这三个目录／default 调用链。诊断 preload 另有每 request 的 AsyncLocalStorage，production-03 也包含这个观察包装；不能把它当作产品 ContactContext 独有成本，也不能视为已测零成本。
- 最小新预测：若 Node 字段解码／包装是剩余 sources 增量的重要来源，应在**同一原 HTTP**里看到服务器结果抵达至 Query promise 完成、或六个 JSONB parser／revision stringify 的时间承担增量；在不删除任何新鲜度／安全检查的观察点计时即可区分。此次只报告该预测，不再开流程。

## 保护目的与可合并接缝

- 必须保留的可观察行为：`backend-ts/test/contact-context.test.mjs:18–25` 区分合法空联系人和未知／跨 owner；`:83–94` 授权关闭再恢复时，在锁前已开始的 sources 返回 409，而后续读取可成功；`:110–126` 移交先拒收、排空并使在途读取失效。
- 同一公共保护还覆盖 `:97–107` 删除时不重建确认，以及 `:158–170` 授权改变后回滚迟到概览投影。这些是静态读取到的既有测试，本任务未重跑。
- 锁前／锁后 revision 比较针对等待期间改变；末尾复验针对查询或派生操作期间改变；ContactHandoff 的 JS revision（`contact-handoff.ts:21–28,34–43`）又是独立的实现移交资格。不能将其中任一层当作另一个的替代。
- 候选深 Module 应留在 **ContactContext 的范围保护读取**，Interface 表达 owner/contact、操作结果和当前资格检查；内部隐藏六阶段顺序及版本比较，不把授权知识散到 HTTP Adapter 或 HostStorage。
- 保守候选仅先评估**两把锁的一个有严格依赖顺序的参数化往返**：保留锁前／锁后／末尾三次独立观察和原事务、错误码、timeout。SQL 的执行顺序须有可验证的依赖，不能凭 SELECT 列顺序；本次未实现或证明任何合并 SQL 正确。两把无竞争锁合计仅约 0.04 ms，优先级应由分段收益决定。
- 不建议将整个序列改成一个 SELECT／普通 CTE，亦不建议改固定快照或复用旧 revision；这些会改变正在被竞态用例保护的观察时机。更深的服务器端 Module 只有在逐步快照、参数协议、锁序与回滚均证明等价后才讨论，不为本次诊断新增函数或迁移。
- 同一 pg Client 上直接 Promise.all 也不能视为往返优化：锁定 pg 8.16.3 的 `lib/client.js:498–517` 在 readyForQuery 时仅提交一个 activeQuery。并行不同连接又会破坏本事务原序。
- session 的候选 Seam 是受认证范围下的 defaultSession 操作，把确认解析与复验放同一受控事务可作为后续设计问题；必须覆盖 `pure-ts-binding-scope.test.mjs:9–35` 的 manual/desktop 隔离及请求结束失效，不能仅删除公开层预检。

## 下一步最小测量（本次不继续执行）

1. 如 root 另给窗口，复用现有固定三个 HTTP，不改统计协议；仅在合成 preload 中把 ContactContext 六阶段、HostStorage inspect、PG 解析、stringify 和 socket finish 分开，并按同一个 request_id 关联。每个计时先缓存在内存，响应后再写一条摘要，避免逐 SQL 同步日志改变被测路径。
2. 若新增 observation EXISTS 真是 contacts 数据库主因，实际 message/source-ref 分支应被执行且服务端时间显著增加；本固定材料 Actual Loops=0，暂不扩大材料或另造评测。
3. 若 DTO／HTTP Adapter 为主因，SQL 完成到响应 finish 的间隔或 stringify 时间应承担增量；sources 空载荷预计不支持大结果量解释。记录实际响应字节和 framing 以区分字段解码与运输。
4. 若范围保护是 sources 主因，在**同一 HTTP 样本**中三次 revision＋两把锁应承担显著增量；本次同 Adapter 微测只能给量级参考，不能扣减正式 HTTP 耗时或作为跳过门禁的反事实 gate。

## 数据处理、验证与交接

- 仅源代码、批准的合成归档／dump／旧运行时；无真实 App、微信、原资料、用户配置、模型预算、外部聊天消息；未读相邻实际资料。
- 只新增本目录文件。生产／测试 WIP 与受保护测试未修改；无依赖安装、agent、新 chat、index、add、commit、push 或 PR。
- 实际执行：一次冻结 Python 后台 `measure-sql.py`（由 stdin launcher 提供精确 pg_restore 环境变量）；`python3 .../analyze-existing.py` 离线复核；`git show`、`rg`、定点文件读取与 SHA256；未运行项目测试或任何新 HTTP。
- 自有库已 DROP 并核验不存在、会话 **0**；连接关闭、测量进程退出，未创建额外运行时／临时目录，保留本目录诊断证据。窗口释放已直接通知 root 与主作者。
- 机器证据：`sql-measurement.json` 保留全部 120 样本／5 计划，`measured-sql.json` 为实际 SQL，`evidence-summary.json` 为离线汇总与输入哈希。原始过程日志在 private/（0700／0600），公开文档不含本机用户名、私有路径、正文或凭据。
- 冻结目录清单见 `manifest.json` 和 `SHA256SUMS`；当前 HostStorage 只记静态读取时摘要，明确区别于 production-03 的被测 WIP，不据后续作者改动冒充已经测过。
