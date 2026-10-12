# 固定四窗有限诊断预注册（2026-10-13）

本文件记录[前瞻工具设计](goal-memory-20261013-forward-diagnostic-design.md)及[第二提示叶](goal-memory-20261013-followup-prompt-repair.md)完成后的独立有限诊断，不是第四基线。原[独立候选](goal-memory-20261013-candidate21-result.md)全部封存与分母保持；七个既有run均closed，真实HTTP34／30个200／4次旧read_timeout远端未知。本预注册当前新增HTTP、预算注册、App、业务库和密钥读取均0，首发仍需Root最后核验与明确授权。

## 固定范围与用途

唯一新run为`86b6a718-b1e4-4203-8f74-27a38f297987`，真实持久预算cap8，仅从从未激活的预留9分出，余1与全量280不启。新immutable amendment-v5保留原index及v1–v4、七个closed真实计数34、全部关闭余额与永久退役未注册12，cap表总480；关闭余额不补位、不复用，不自动开启后继。

固定局部位置0/1/2/3对应原Gold位置0/1/3/4，即A01/A02/A04/A05；完整原Gold仍21窗／28必需命题，所有难例与标准答案不变。诊断局部分母为4窗／5命题，未选17窗单列。A01/A02/A04仅能与既有正式历史输出作知情对照，A05旧formal unknown保持，新输出只作独立控制；不冒称随机、交错、完整paired或≥15质量证据，不给旧迟到结果补分。

唯一最终未激活方案固定台北`2026-10-13 05:25–07:25`，最后HTTP起发点`07:19:15`，每次预约前须留300＋45秒；不因准备占用时间而滚动截止。原05:20及05:45草案保留未激活，最终proposal-v3另存。根`.env`只在后续已授权的实际run领取预算后由原受控loader读取，仍仅现有ECNU／请求模型`ecnu-max`，历史服务报告alias另列；SDK与两HTTPX timeout300／max_retries0同值，不改变thinking、置信、质量门或生产默认空放行表。

## 前瞻审核与有限操作期限

审核`safe`描述输出忠实且未知边界明确；准确保留未知身份／事项并正确pending可以safe。`ambiguous`描述输出未守住这些边界或不宜确定采纳；wrong_person、false_fact与unresolved仍按原含义。此说明仅适用于新run，原A03 sealed ambiguous及full0保持；safe-only完整门、原Gold和旧审核不改。新工具只在actual-auto映射到原E非空alternatives、或显式group.destination失败时强化安全计数，不授权产品auto。

每窗先逐项审核原E14，保存显式raw答复并由PhasedAudit核验持久封存后才给full。full再逐项核实际V4、V语义、实际V输入及accepted、final、lineage／去向，不能用V supported救E。每个raw/full阶段均固定600秒，读答复前／后和最后sleep之后均复核monotonic期限；600属于操作期限，不降低语义门。每阶段独占保存clock-start／clock-end元数据，含UTC、单调起止、完整／紧凑视图摘要、是否收到答复和固定停止分类。等待missing、读取late、存储／guard或未知异常不能默认通过；绝对07:25 SIGALRM同时约束API、batch、审核与收尾。

完整raw/full视图继续0600独占保存，紧凑投影另存且带完整canonical摘要。raw保持当前window、完整E14、当前Gold窗与规则索引，不揭示V／程序层／sealed答复；full仅在raw封存后保存所有实际layers、original_result、sealed raw及持久raw receipt。共同规则完整另存600文件并核其摘要，未删除相关规则或当前字段。PhasedAudit原视图本已没有provider内部思考，新桥未声称首次去除了思考。

既有公开合成A01只作尺寸验证：canonical raw23925→compact5340字节，full92760→9733字节，共用规则19236字节一次保存。原视图／标签不变，此投影不新增语义分或模型调用。原始真实聊天或视觉帧不在此次范围。

## 停止与终态

任何来源／载荷／版本漂移、HTTP或工具契约失败、unsafe或unresolved审核、缺失／非法／迟到答复、预算／持久记录／cleanup失败或未知，立即停止该新run并closed，保留unknown／unrun和收据缺口。已有注册目录即使尚未使用也拒绝复开；主入口不完整、关闭缺口或收据不可核均exit1。关闭后保存结果使用原strict `_json_value`，UUID／datetime规范转换，未知对象拒绝且不写半份JSON。完整运行与工具绿都不自动签quality，后三原质量票及维度批准仍需原证据。

## 冻结与实际最小验证

私有证据根为`/private/tmp/notalone-memory-goal-20261013-ac04d687/`，0700目录／0600文件；源码提交`9ce4c4d72a70faf266653c6e662735d7b8e4cae2`的60个当前源码、公开Gold及注释字节逐blob吻合，21输入仍原序，8安装版本冻结，新UUID注册缺席。Root在实际stage期间冻结这些来源与Git提交。

固定bundle规范SHA为`d9bc40f0a659c8e0cfa9baa6d2c0ee96bf3dea4f97b6caf557a4fe34507e3541`；amendment-v5规范SHA为`f31425ae2165ec477443f0712aa8d27377491ba2d391214631dcec53679d6ab2`。runner字节SHA为`334d87a62dc343a5f05f8ec62ee44277761bf8f8a0a0b682e8551b9e8e2b4dba`，compact为`b1f2d34e6963c8ec85724cb6638ea725bb8bf423ad8d33751a7e74e7445896dc`；selftest、guard、common rules及全部验证摘要在`diagnostic4-freeze-review-metadata.json`。

私有文件交接先20方法实际2fail，再22方法实际5个断言fail：bool位置别名、未知phase及三种关闭／记录错误仍exit0；两次红均保留。最小修复后22／22绿0.194592500秒，补冻结helper键后对最终字节再22／22绿0.210828125秒。最终冻结负控8／8绿0.045811167秒，覆盖原选择／cap／deadline／原分母／后继禁止、旧关闭收据、来源字节漂移和规则／helper摘要；未编辑真实来源或收据。600秒边界用受控单调时钟，不声称实际等待600秒。compact独立7／7首次即绿，诚实保留首次绿，不编red。两私有源码`mypy --check-untyped-defs --ignore-missing-imports`通过，未记录其完整单调用时；五脚本AST通过。

验证脚本固定禁止真实socket／DNS及`.env`，API测试由精确合成Mock或隔离临时HOME预算执行，真实新HTTP0／真实注册0；临时预算与文件由自有TemporaryDirectory清理。证据`diagnostic4-selftest-{red,red-2,green,final}.{json,txt}`、`diagnostic4-guard-selftest-result.json`、`diagnostic4-compact-selftest-first-result.json`、`diagnostic4-private-mypy-{first,final}.txt`及`diagnostic4-compact-size-proof.json`，全部原失败保留。最终计划两轴和Root首发核验另记，当前不能把这些合成验证写作真实模型收益或21窗质量达标。

Standards与Spec最终独立只读均未解决0，逐核60当前字节与9ce提交、九个冻结文件／0700与0600、七completion固定预算closed合34、新UUID注册缺席、cap表480和固定时窗；审查者没有执行模型、App或读取思考／秘密。另一个人工装配助手`manual_diagnostic4_review.py`字节SHA`2d89879e6a0d98260c619e527ee907944b62904a9d31ea8f1ff92df894ed66cf`仅将既有助手prefix与选位改为本stage local0/1/2/3，拒未知case／phase；stdin仍要求显式E14／V4／claim／lineage判断，原结构校验和O_EXCL保存不变，AST与两轴增量通过，尚未实际执行。Root仍须最后独立核验并授权，首发前不注册预算。
