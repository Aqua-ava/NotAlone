# 四窗分支对照的V HTTP500终态（2026-10-13）

唯一run `e910bd79-c4c1-4f0b-bf4a-56e946c65dcd` 按[有限预注册](goal-memory-20261013-stage-priority-diagnostic4-plan.md)执行，固定原A05–A08四窗／五必需命题，cap8。原03运行字段、窗口投影兼容及两SYSTEM提示共同进入本次冻结；依赖清单178项是受限源码超集，不代表178项全部实际执行。源／Gold／评分门与旧封存未在场中改写。

实际UTC03:43:51.691进入唯一评测入口，driver单调7.821042375秒、exit1。持久预约2次：E HTTP200并取得一条14字段合法工具候选；V HTTP500，21字节非JSON错误响应只保存摘要，原文未落盘。六事件依次为case、E请求／响应／解析输出、V请求／响应；没有raw或full审核文件。正式完成0窗、A05 unknown、A06–A08三窗unrun，`plan_complete=false / quality_certified=false`。这不是合法空E，也没有可用于完整命题、指代或自动采纳质量的成绩。

外层停止码`ecnu_hard_stop`的本次具体链路已经核实：[响应记录器](../../backend/src/notalone/memory_extraction/evaluation_records.py)先记录HTTP500及摘要，再因`response_redaction_unavailable`关闭预算；[受控transport](../../backend/src/notalone/memory_extraction/evaluation_http_budget.py)关闭响应并传播停止；[批次入口](../../backend/src/notalone/memory_extraction/evaluation_offline.py)将当前窗保留unknown。请求在发送前通过冻结契约，受控HTTP transport确实取得500；没有HTTPX失败事件或合法V工具解析。SDK与双HTTP transport的retry均0，E／V各发一次。该链路证明合法构造请求后收到服务错误，不定位ECNU内部组件或根因。

随后在禁止DNS／socket／默认HTTP、根.env读取和预算登记的离线守卫下，用本场已保存的公开E14候选重建真实[V正文投影](../../backend/src/notalone/memory_extraction/verification_adapters.py)：正文与本次实际V请求逐字相同；再显式给Fact增加非空`dimension_evidence`，正文仍相同。V消息为五槽、候选为十一槽，不含新维度字段或消息类型／表示元数据；[Flow](../../backend/src/notalone/memory_extraction/flow.py)实际在V后生成该维度证据。本次DTO没有产生所谓第十五个V候选槽。

旧21窗文本控制确实每窗传入一个非空Fact，但只比较新旧窗口元数据的格式投影，并未模拟丰富维度证据或真实21窗输出。本次补充非空维度证据的重构弥补了这个技术范围缺口；它不能证明E/V语义质量。离线诊断新增网络HTTP、预算登记和正式审核均0；导入阶段一次urllib3 IPv6 `socket.bind`探测被守卫拒绝，未连接端点。

与既有成功的同A05 V请求及A02单V控制相比，`model / temperature / stream / thinking / tool_choice / tools`完全相同：请求model仍`ecnu-max`，thinking仍enabled。SYSTEM及候选正文／部分语用标签有所变化，实际V请求9860字节（旧同A05为8819），本次用户正文568字节（旧同A05为590）。这些记录不证明或排除体积、Thinking、提示或上游状态是500原因。E成功响应报告alias为`deepseek-v4-flash`；V错误响应没有可解析型号，二者与请求model分列。

预算成功CLOSED2/8，余6永久关闭，不resume、补位或重用。Root独立核SQLite闭账及序列1、2，原持久锁以只读非阻塞独占取得后释放；唯一已记录入口PID消失，客户端／记录／收据／cleanup无错误，所有证据与锁文件保留，未删除未知资源。178冻结源与18私有冻结文件无漂移；这只证明已记录本地资源，不认证完整OS或远端服务进程结束。本场App／微信／真实聊天／业务库／消息发送0。

本持续目标11个run全部closed，累计61次真实HTTP尝试＝56个200＋本次1个500＋旧4次ReadTimeout远端未知。177次关闭未用、12次退役且从未登记、全140专属280尚未激活；`61+177+12+280=530`为工程有限分配账，不是用户给出的数字额度。原State／AC、Gold21／28必需＋1可选、全部旧sealed和默认空放行表保持。尚无新prepare／注册／HTTP授权，本次技术停止不能写成语义通过或完整目标完成。

## 私有证据索引

全部位于`/private/tmp/notalone-memory-goal-20261013-ac04d687/stage-priority-diagnostic4/`，原文件0600、父目录0700；索引不含真实聊天、凭据、内部思考或错误响应原文。

| 文件 | SHA256 | 证明范围 |
| --- | --- | --- |
| `completion.json` | `bf13b35891908a0c4f3d2c0c2abfa427ccf617420e51a9b017f74f4c84f95ee9` | durable closed2/8、unknown／unrun、缺口 |
| `run-result.json` | `9ded22dcacd0b767f50a5534791099dbe6dda90db31bd2e38546d2e0015bed95` | 原批次结果，正式审核0 |
| `run-summary.json` | `e7f4d9856fc01c42f0721dbfb1d9f0bf4e88ff5e7f6694e1acf8a923b0e97713` | 单调时长、exit边界及计数 |
| `terminal-collector-v1.json` | `20700b8643d17b2bd2f21476d84b032c6b4199c7332eaac915f09270870a9de8` | 事件摘要、只读SQLite／锁／PID、资源范围 |
| `root-terminal-independent-v1.json` | `5f1c9f61cf55d5ee34949975be71210edd2b56cf71418c4b9a99df5f1335d5b5` | Root独立终态核验、解除冻结 |
| `v-body-diagnosis-v1.json` | `cabe597d4cd9ec213f84214a75f4728787468dd6494f1350adceab9198639465` | 0网络重构、实际槽与旧成功请求参数比较 |
| `v-stop-source-evidence-v1.json` | `cd947604c606aaabb9c0be7320076b3fe49e2df876a90337485f517af7bf1d34` | 具体停止子因及源码边界，内部根因未知 |

首次额外HEAD恒等预检因共享历史元数据改写而拒绝，发生在任何activation／登记／请求写入前。Root另核178当前字节、原冻结提交及公开映射逐blob相同后按原bundle唯一激活；没有第二prepare、改UUID或延长窗口。该拒绝、原提交绑定和独立放行记录保留在私有总目录，不改原封存来掩盖失败。

本片只新增结果文档及原三票底部Comments；已核七份证据摘要、九个新增相对链接、三票追加前缀及原状态保护，无新增尾空白。双轴结果由独立审查另记录，没有为文案重跑模型或测试。
