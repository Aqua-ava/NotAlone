# 固定21窗独立候选预注册（2026-10-13）

本片承接[最后基线实际安全停止](goal-memory-20261013-baseline300-result.md)与[最小共性提示修复](goal-memory-20261013-common-prompt-repair.md)。旧控制只完成A01–A05：必需命题6、raw5、accepted5、完整0，A05评测理想三门bad_auto1使批次安全停止；16窗unrun及关闭余32永久保留。候选不是第四基线，不把旧5窗称作有效21窗控制，不为新输出改Gold、删难例、阈值或默认空放行表。

仅E/V两个原system提示常量已独立提交`c370959be14c3e711090cea349bc26b09f30a0f3`。共性修复为必要上下文引用、未知备选不猜职业／亲友角色、历史经历与近期状态／来源观察日区分、保留临时限定；schema、解析、存储、Gold、维度及采纳门不变。真实模型效果尚未检验；111项相关回归、mypy3文件与新仓库外driver25项Mock红绿只证明相应代码边界。原冻结桥不改，新副本以原严格`_json_value`保存关闭后的UUID／datetime，未知对象仍拒绝，不用`default=str`。

新不可变`goal-budget-amendment-v4.json`保留原index与v1–v3，显式撤销未来54原“完整21控制”启用条件，替换为“前5窗正式语义安全停止、真实E/V完成且closed”。未来专属allocated54分列：唯一新注册`02e6662f-ce11-4d28-be10-b66b1ef30e13`实际cap42；另12永久退役、不注册、不挪用，仍包含在总480中。旧六run真实24均closed，关闭余38／2／40／1／32不复用；全量280及预留9未启，后续不自动启动，不补位或换ID。以下只是准备，Root最终冻结授权前新实际注册与HTTP均0。

固定输入与判据为已有公开A01–A19/B01–B02共21窗、28必需命题＋A15可选1，Gold与日期政策均未修改。前5窗仅与旧5窗做历史A/B逐命题对照，未随机化或交错；后16窗旧控制未知，只按固定Gold独立报告。不能声称84次全配对、整套改善率或新留出结果。原matcher、E14字段、V4字段与语义、raw／accepted／完整覆盖、安全计数及窗口去向分别保存；V supported不能救错误E字段。评测理想三门去向与真实生产默认空维度表分列，无业务写库或自动放行。

固定观察场次 **2026-10-13 04:05–06:05 Asia/Taipei**，截止不滚动；每次真实HTTP含SDK重试都必须在 **05:59:15**前持久预约，留下300＋45秒起发余量。实际公开ECNU入口、双HTTPX与SDK均用`request_timeout_seconds=300/max_retries=0`，请求模型`ecnu-max`与服务曾报告的`deepseek-v4-flash`另列，不切供应商或改变thinking。读取超时不是墙钟上限；仓库外绝对06:05 SIGALRM覆盖API、batch及两相审核与其finally，并恢复原handler/timer，既有alarm不覆盖。达到截止保留未完成，不能算通过。

每窗先只给E/window/固定Gold raw视图，主审核逐14字段、命题和安全显式填写，验证并持久封存后才显示V/final的full视图；不称盲审，无自动默认通过。每相300秒、读前读后与绝对时限均核，raw封存摘要复验。普通general_error记录并继续；unsafe／unknown／未决审核、接口／来源／payload漂移、预算／记录／关闭／收据失败立即停止，未知计数保留null。不完整即闭run、未运行保留，禁止第四基线或自动54补调用／280回归／9技术场。若完整，也须按原门槛独立报告和后续具体批准。

冻结源码60项逐字节来自上述提交，固定21窗与原输入／参考一致；准备时六closed收据、原index／修订、8安装版本、0700目录与0600文件以及新run注册缺席已核。新元数据根为`/private/tmp/notalone-memory-goal-20261013-ac04d687/`：

| 冻结项 | SHA-256 |
| --- | --- |
| `candidate21.py` | `28f318f50a377ae5f57cfd4948d353542d6c0b0dac419a721e4aec07191ddf15` |
| `candidate21_selftest.py` | `91dd49470c9a0af791a7d866b91789efc1a44d33a5afdaf8682ba96e68d712b6` |
| `candidate21-plan-v1.json`（规范JSON） | `18c94fd1abdb63c41d07ea881b372f8b5703bb1f978c7badbdd431888240d709` |
| `goal-budget-amendment-v4.json`（规范JSON） | `d78ba798ed70da007b0197a0b675cc557197b6864d1f972494fe09d97600e299` |
| `manual_candidate21_review.py` | `0fc5afa20a374f2f1c0b6988a4ef553032e5514ebf0b68f50066dfb8025ca50e` |

参考规范摘要`5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32`、判据文件`5ab68ad8fbb48348231b27ae600ca011e47bf7fc2c1aa2f4e5b417bfa392d5a6`、标注`7039a302f64d6a14761ae448e425597c5ef46e0fbb3d7bc41c95c6d9a9b91e91`保持不变。`candidate21-freeze-metadata.json`只保存准备核查，无凭据、思考或provider正文；manual helper只把旧helper的阶段目录替换，其判断流程相同。最小提示片两轴0；桥准备预审两轴0，最终新amend／bundle仍须独立两轴及Root首发前再次核实时刻、源码、持久SQLiteclosed总计和新注册缺席，不能借Mock或本文件代签实际运行。

授权后唯一命令为Conda `NotAlone`下`python /private/tmp/notalone-memory-goal-20261013-ac04d687/candidate21.py run --bundle-sha 18c94fd1abdb63c41d07ea881b372f8b5703bb1f978c7badbdd431888240d709`。根`.env`仅沿已有受控loader在预算领取后内存读取ECNU必要三键，不回显或提交；范围只有固定公开合成材料，无真实聊天、App、桌面或业务库操作。
