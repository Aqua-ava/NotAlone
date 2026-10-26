# 完整宿主同请求阶段诊断：一次固定流程

2026-10-26。本轮480/480请求成功，墙钟16.848秒，无重试、增样、延长预热或第二实验。结果支持把本轮两个GET的主要时间缩到实时结构核验中的catalog结果等待；尚未证明PG、解码、调度或JIT的具体根因，没有产品patch，也不批准性能或25/26。

## 固定范围与实际执行

- 生产基线精确1e90；准备时HEAD04aa，启动时HEAD b8ba，均为元数据变更。相关产品文件与1e90一致，主树源码、三份用户文件、依赖和Git index未改；原静态7文件保持原SHA。
- A旧锚→B完整新基线→C相同完整宿主仅私有源码计时→D旧锚，单并发；三原路径每宿主10暖机+30计分，480原样本全部保留，另160次原session持久HTTP读回全部成功。
- C仅六个私有源码文件插时点，原ALS和request→finish计时点保留；不patch pg.query/callback/parser/Promise，不新增async_hooks、GC observer或profiler，不删安全核验/后台功能。源码差异见observer.patch，全部原样本见result.json与各trace。
- 实际冻结plan Node为v24.19.0，二进制SHA匹配plan；不是其他回复验收记录中的24.22.1。固定Python、Node、双依赖、dump/workload与原工具前后摘要核验全部通过，具体SHA在preflight.json/result.json。
- 测试适配器给新旧宿主各自TMPDIR；两个新臂共同透传该值，将临时profile及模型控制socket限制在自有目录。控制驱动PATH使用获准PG/Node目录，宿主PATH沿用specification；控制PG显式OS user且不输出值，产品connectionOptions未改。这些环境事实不隐藏，也不代表已证明产品没有Conda依赖。
- 实际执行prepare.py（仅归档/文本插桩）、语法检查（仅类型擦除+语法解析，无模块执行）、冻结launch.py→run.py一次、独立只读资源核对，以及analyze.py离线统计；未运行项目测试、typecheck、全量、真实模型、App/微信或打包。

## A/B/C/D及观察器扰动

服务器request→finish，单位ms；每格30个计分样本。

| 路径 | A p50 | B p50 | C p50 | D p50 | D/A p50变化 | C/B p50变化 | C/B p95变化 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| contacts | 1.736187 | 3.863250 | 3.932292 | 1.887938 | +8.740% | +1.787% | -11.485% |
| sources | 1.193479 | 4.043937 | 3.959062 | 1.191167 | -0.194% | -2.099% | +2.224% |
| session-default | 2.252854 | 2.594749 | 2.565854 | 2.237083 | -0.700% | -1.114% | -5.503% |

| 路径 | A p95 | B p95 | C p95 | D p95 | C/B客户端p50变化 |
| --- | ---: | ---: | ---: | ---: | ---: |
| contacts | 2.032573 | 5.011313 | 4.435763 | 2.195987 | +2.013% |
| sources | 1.587733 | 5.250110 | 5.366894 | 1.501404 | -2.010% |
| session-default | 2.803463 | 3.520194 | 3.326475 | 2.651889 | -1.004% |

B/C总p50的变化约在±2.1%内，未观察到与待解释2–3ms同量级的总扰动；客户端也没有相反的毫秒级增量。但固定顺序和contacts旧锚+8.740%的漂移使“纯观察器成本”仍不可单独辨识，不能把负变化称为加速或把本轮C当未插桩性能。finish取时后才追加CPU/ELU快照及原同步HTTP行，新阶段缓冲在进程正常退出时一次写入；此部分工作可能影响客户端或下一请求，故客户端差异同时保留。没有新增或更改正式门槛、bootstrap或统计口径。

## C同请求阶段

下表为计分p50 ms；每个单事务区段均30个样本。占比先逐请求相除/求和，再取中位，不能由中位数简单相加。catalog dispatch→result包含文件核验；这里只将完成文件核验后的catalog.await→catalog.result称为“残余等待”，尚未观测PG实际返回时刻。

| 路径/事务 | ingress→context | context | fresh inspect | fresh files | catalog残余等待 | inspect占HTTP中位 | 残余等待占HTTP中位 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| contacts/1 | 0.032084 | 3.869146 | 3.020104 | 0.478084 | 2.121729 | 77.580% | 54.234% |
| sources/1 | 0.024562 | 3.905354 | 2.463980 | 0.368875 | 1.822938 | 63.735% | 46.393% |
| session/1 | N/A | N/A | 1.023917 | 0.307397 | 0.566146 | 两事务合计80.142% | 两事务合计45.013% |
| session/2 | N/A | N/A | 1.031917 | 0.291708 | 0.573688 | 两事务合计80.142% | 两事务合计45.013% |

- contacts/sources的private false await为0.007958/0.005979ms，public false await为0.001750/0.001917ms；认证0.004042/0.002979ms，JSON 0.004041/0.001000ms。两个GET的ingress→context p95仅0.049741/0.041479ms，context→finish p50 0.040146/0.026355ms。它们不能解释本次毫秒级主差值。
- 两GET的catalog dispatch→result p50 2.682229/2.232333ms，inspect总3.020104/2.463980ms；这几个span嵌套，不能再加上files或SQL等待。commit为0.050062/0.041938ms，COMMIT后释放0.043875/0.032937ms，释放阶段没有漏算。
- session固定手动header路径的body读取0.016125ms，解析0.003458ms；两个完整storage事务1.180625/1.318937ms，默认session子段1.320729ms。其SQL/事务形态与GET不同，且位于固定序列后段，不能把更快catalog当作独立因果对照。
- C中实际ready=unconfigured、taskEvents=true、maintenance=false。仅记录到一次task刷新4.757ms，在首个标记请求前37.028ms结束，与120个标记请求的重叠为0；整个标记请求区间641.499ms。本轮不支持这个刷新直接抢占慢样本；未观测的GC/JIT/其他工作仍unknown。
- 进程CPU p50 contacts/sources/session为1.319/1.0975/1.266ms，ELU中位约0.335/0.277/0.539。它们是共进程计数，不能称单请求纯CPU，也不能从低ELU直接认定某条SQL耗时。

## 每个边界的分母

- C全部120请求、90计分均有唯一finish；三路各40全样本/30计分，10暖机原样保留。主要外层、body/响应及事务点没有缺失；GET才有context/public.after，POST才有body/session/public.handled，N/A不伪装为缺失。
- contacts/sources每个storage/config/acquire/inspect/files/catalog/commit/release点为40次全样本/30计分；session同样覆盖40/30个请求，每请求两事务，相关事务点共80/60次。所有静态SQL时点的逐label“请求数”和“出现次数”均保存在analysis.json的cases.*.boundaries，不用含混的总数代替。
- 每个计分请求的顶层相邻时点区间加和，和同request_id原HTTP时间误差最大0ms；时间逆序0，样本/时点/事件缓冲溢出0。新observer没有逐SQL同步落盘。完整标记数据见C-full-observer-stages.json。

## 下一处可验证的具体假设（本轮不执行）

优先定位`backend-ts/src/host-storage.ts:431–457`：查询发起、fresh文件核验之后的catalog等待。假设是该查询的PG端处理/响应交付主导残余，而不是两个前置async false分派。若成立，下一次保持完整请求的观察应看到PG响应到达或PG执行/规划覆盖主要残余，而pg完成→本await恢复很短；若响应早到、客户端处理或恢复很长，则推翻并转向解码/续点。当前不能在三者中选根因。

只有root另行审阅后才考虑最小私有观察范围：同一已装载pg实例的`pg/lib/connection.js:111`数据处理、`pg/lib/client.js:302,374` ready/dataRow与`pg/lib/result.js:63–75`逐行解析，关联本条catalog到`host-storage.ts:457`。先核实际对象/文件和观察副作用，保持query/callback/返回语义，不全局替换业务接口；是否需要PG端planning/execution证据另定。本轮没有实现或启动这项扩展；尚无足够依据提出SQL/缓存/锁/DSH的产品patch。

## 失败、保留缺口与收尾

- 实际HTTP流程失败0、未尝试0、原持久读回失败0、模型receipt/ledger0、网络拒绝尝试0。准备阶段的唯一替换断言失败、直接node --check TS模式不适用，以及启动器SHA辅助函数错误均保留；它们分别发生在任何实验PG/HTTP开始前，不计作产品或HTTP失败，也不删除这些记录。
- 两次早期静态准备/启动器错误最初只由工具返回，没有从进程开始直接留原始stderr文件；已保存错误信号/代码摘要并明确此缺口，不声称所有准备raw齐全。其后的准备/语法检查以及实际driver/各宿主日志均从开始留在自有私有子树；公开脱敏副本和raw/public双SHA见最终清单。
- 驱动退出；自有四库/会话、进程、源码副本和运行时临时目录均清0。独立只读核对匹配夹具数据库/会话也均0；实际driver/宿主raw初始即0600；之后两份离线分析重定向日志曾继承0644，父目录始终0700，最终扫描发现后已修正0600并记录，最终违规0。原始日志和必要证据仍保留，不把“临时目录0”说成删除全部证据。
- 独占窗口已明确归还root，此后只离线分析。主树与原静态7文件未变，无add/commit/push；没有全量/正式40启动×60秒RSS/96回复/最终App验收。正式性能、25/26仍未批准。
