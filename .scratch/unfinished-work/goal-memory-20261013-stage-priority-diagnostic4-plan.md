# A05–A08分支优先修复四窗有限预注册（2026-10-13）

本场仅准备，源码冻结、私有不可变bundle、预算注册和Root激活均待完成，真实HTTP为0。预算修订见[独立amendment](memory-goal-budget-amendment-v8-20261013.json)，文件SHA `f15a966228898c66fc515e944e6650c15ceccb3ed1578d6bb29ec5b16e20c5dc`。用户允许本目标使用现有ECNU；工程总上限530来自Root的有限分配，不写成用户给出数字额度。现有10场持久CLOSED合计59次，确认200为55次，旧4次ReadTimeout的远端处理仍未知；171次已关闭未用余额及12次未注册退役额度永不复用。原全140专属280尚未注册，本场只新增独立8，不借旧余额，也不自动开启后继。

## 固定样本和观察目的

唯一run为`e910bd79-c4c1-4f0b-bf4a-56e946c65dcd`，使用原完整21窗Gold的固定位置`(4,5,6,7)`，共4窗、5个必需命题。Gold文件SHA `5ab68ad8fbb48348231b27ae600ca011e47bf7fc2c1aa2f4e5b417bfa392d5a6`、规范摘要 `5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32`、输入和target保持；未选择的17窗和全套21窗／28必需＋1可选分母保留，不删难例、不回写Gold或旧封存。新119候选参考尚未ready，不参与本场。

| local位置 | 原Gold位置 | case | 原公开名称 | 必需命题 | 历史对照范围 |
| --- | --- | --- | --- | --- | --- |
| 0 | 4 | A05 | 指代：姐借车 | 1 | 正式历史观察 |
| 1 | 5 | A06 | 指代：机场等行李 | 2 | 正式历史观察 |
| 2 | 6 | A07 | 指代：他们来家 | 1 | 正式历史观察 |
| 3 | 7 | A08 | 指代：那本书 | 1 | 旧full未知，不配对 |

本场依据[完整21观察终态](goal-memory-20261013-complete21-observation-result.md)中的真实A05–A07字段失败和A08已保存raw／未知full准备。[最小两SYSTEM修复](goal-memory-20261013-branch-priority-prompt-repair.md)已本地提交`d42105b1`，但这不冻结其他Agent正在实施的原03DTO／mapper／维度合取／存取工作。只有A05–A07拥有正式历史审核，可作非盲历史观察；旧A08 full因缺答复停止，不能作正式配对对照。共同源码及运行时改变会单列，不能把变化全部归因于两个提示常量，更不能称随机交错A/B、旧完整基线或≥15窗维度质量达标。

## 有限场次和发送上限

固定场次为台北2026-10-13 **10:30–12:30**，最后HTTP起发为 **11:59:15**；UTC分别为02:30–04:30／03:59:15。窗口未通过准备或源码稳定条件时保持0注册、0HTTP，不滚动延长或换UUID补位。Root最后时点授权后，只有真实clock处于固定起发窗内才允许唯一执行器注册；总8次预约／真实尝试硬限，每次SDK发送与重试都必须走持久预算，已闭余额无法恢复。

实际受限ECNU入口显式`request_timeout_seconds=300`、`max_retries=0`，同值贯通SDK及两个HTTPX transport；沿根.env现有配置的既定最小loader，不读取／回显或提交密钥，不改变供应商、模型、thinking、Gold或质量门。300秒是读超时，不冒称总墙钟上限。每次HTTP在预约前核最后起发门，保留1845秒（两次300读超时＋两次600审核＋45余量）；绝对12:30 timer覆盖API、审核与收尾，期限触发不计完成。普通质量错误如实继续固定余窗，任何unsafe、未决、安全错误、技术unknown或门禁失败立即停止，关闭本run余量；无后继自动启动或第四基线。

## 审核和质量边界

复用既有`run_ecnu_evaluation`受控接缝与`PhasedEvaluationAudit`的不可变local→原Gold映射，不开放任意case／validator，不走无计数CLI。每窗先生成E-only完整原视图与可核验compact，逐命题及14字段显式提交Agent审核，持久封存验证后才揭V／程序去向的full；再逐4字段、来源、证据、lineage、理想destination和safe-only规则审核。两个阶段各600秒，从冻结及case身份核验完成后、写view前起算，含compact／view保存耗时，读前后均复核；不默认pass，不用V支持救E失败，不用补标或迟到答复救旧成绩。

忠实保留未知且界限清楚可为safe，但错误确定指代或不适合确定采纳仍需ambiguous／unsafe；原safe-only、置信／风险／来源／质量门及默认空放行表保持。typed运行字段和所有相关维度AND门单独记录，不以字段存在代真实质量；本场actual auto是评测去向时须明确标注，不能冒称生产放行或写入真实库。原A04失败、A08 full未知、全部旧封存和已关闭实验继续保留。

## 源码冻结、工具准备和证据

后续冻结须覆盖届时**全部实际依赖源码及受限依赖超集**，含原03新增evidence、维度DTO／绑定等模块；旧60清单不可复用。私有纯AST库存`stage-priority-source-dependency-inventory-draft-v1.json`列173候选路径，是包含类型检查及函数分支的过覆盖草案，不证明173个模块实际执行。待03相关验证和本地提交稳定后才逐文件核工作字节与指定commit blob，绑定原Gold／输入、库版本、所有旧闭账收据与新工具SHA，并由两轴和Root最后核验。此时`source_commit`／`source_hashes`仍未冻结。

私有新桥`/private/tmp/notalone-memory-goal-20261013-ac04d687/stage_priority_diagnostic4.py`只有草案AST解析通过，`SOURCE_COMMIT=UNFROZEN_RUNTIME03_COMMIT`强拒prepare和run；原桥不修改。本场尚未运行新Mock、类型检查或调用入口，不把已有22项两SYSTEM接线绿或原03测试当本场工具／语义成功。新的最小Mock须覆盖位置映射、迟到／缺失答复、布尔错位、重开拒绝、1845起发边界、绝对timer、未知计数null、严格JSON、收据及cleanup失败退出，真实网络／根.env／旧内容读取均禁止。

注册／激活前证据目录仍为`/private/tmp/notalone-memory-goal-20261013-ac04d687/`（0700／记录0600），Root最后冻结后为本run独占新输出和审核目录。实际执行需唯一session／owned PID、每次持久尝试与状态码、各案completed／unknown／unrun、单调耗时及阶段clock、completion和退出状态；收尾核客户端／记录／收据／cleanup错误、CLOSED与in-flight锁释放。持久SQLite、失败日志及封存不删除；进程和资源只签实际核到的自有范围，不推断供应商远端停止。

本预注册没有实际App、微信、OCR、浏览器、业务库、消息发送、预算注册或模型请求，也不改原票State／AC。新模型证据必须完成原来源和语义门才能支持原票，4窗诊断的成功或失败都不能代替21／140完整验收。
