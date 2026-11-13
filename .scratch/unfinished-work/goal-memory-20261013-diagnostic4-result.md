# 固定四窗实际终态与剩余语义失败（2026-10-13）

[预注册](goal-memory-20261013-diagnostic4-plan.md)唯一run `86b6a718-b1e4-4203-8f74-27a38f297987`已在Conda `NotAlone`实际执行并closed。原公开Gold位置0／1／3／4对应A01／A02／A04／A05，ECNU请求模型`ecnu-max`、SDK及双HTTPX `300/0`不变，服务实际报告`deepseek-v4-flash`另列。driver原单调时长 **857.171293708秒**（14分17.171秒），sole CLI session3461 **exit0**；持久SQLite **8/8**，44个事件中的8个provider_response逐条核为真实HTTP200。正式 **4completed／0unknown／0unrun**，技术计划完整，但四窗正式semantic audit均为general_error，**quality_certified=false**。没有新基线、后继调用、生产放行或业务写库。

完整原Gold仍 **21窗／28必需命题**，本次选择 **4窗／5必需命题**，未选17窗保留。正式计数为必需raw **3/5**、程序accepted **3/5**、完整契约 **1/5**。A01正文的两项核心含义均保留，但身份备选导致原审核group.coherence失败，冻结计数器因此将这两项raw及accepted记0；不能把正文覆盖单独观察替换正式3/5。旧程序matcher摘要中的4passed仅为旧去向／字段计数，不能替代本次四份正式general_error。

| 窗口 | 正式raw／accepted／完整 | 字段及实际失败 |
| --- | --- | --- |
| A01（分母2） | 0／0／0 | E13/14通过，classification、report/reported、来源、双null和正文两核心含义正确；alternatives加入窗内无据的联系人或用户圈子可能关系，未守住未知第三人边界。V四槽及语义通过，但V输入没有该备选槽，不能救E。最终pending。 |
| A02（分母1） | 1／1／0 | E14/14通过，上文老李与target来源齐全，历史邀约按report/reported和双null正确保留；实际V把它降为uncertain／pragmatics，verdict及issues两槽fail、V语义fail。实际新增semantic:pragmatics风险保留，不移除救分；最终pending。 |
| A04（分母1） | 1／1／0 | E13/14通过，正文“先”、来源日期、未知事项备选、request/asserted和临时去向正确；interpretation_reason无据添加“当面”场景。V四槽及语义通过，但看不到该理由，不能救E；最终pending。 |
| A05（分母1） | 1／1／1 | 必需历史借车主张及另一条“有姐姐”候选共E28/28、V8/8通过，借出方向、双null、来源、lineage与理想auto正确。后一条是有来源的额外主张，原Gold没有optional槽，按extra记1，正式case仍contract_mismatch／general_error；不删输出或补Gold救分。 |

E共70字段 **68pass／2fail／0unresolved**，V共20字段 **18pass／2fail／0unresolved**，V语义 **4pass／1fail**。额外候选1，duplicate／excluded、重复来源、未映射V／final均0；false_fact、wrong_person、bad_auto、ambiguous_auto、unmapped_auto、unresolved_auto及review_unresolved均0。五个final中3pending、2个A05 benchmark auto，仅是评测理想三门去向；生产第4道维度门及默认空放行表未改，未写库、未记用户确认，不能以本次局部安全0签≥15条、21窗或140窗质量。

八份raw／full显式审核答复（由Agent提交）均在本次600秒期限内被接受，原raw封存后才揭V及完整层。各阶段原monotonic秒数为：A01 raw81.730534292／full30.986004541；A02 raw65.702435708／full36.905719791；A04 raw155.327984250／full24.484180083；A05 raw93.758389750／full62.611971500。各clock-end均review_received=true、stop_code=null，最大155.328秒；没有补迟到审核或改旧sealed。紧凑视图与更长操作期限这次完成流程，不能据一次运行证明它们单独的因果收益。原A05旧候选full迟到与unknown继续保留，本次正式1/1/1只属于新run。

原60个源码与`9ce4c4d7`冻结SHA逐字节无差异，client／records／receipt／cleanup错误均空，capture_gaps=[]。预算SQLite与closed marker只读核closed=1；in-flight.lock作为原持久文件保留，用O_RDONLY及LOCK_EX|NB成功取得后立即释放，证明没有持锁请求，未删除文件、closed、claimed或计数。本机评测入口已exit0，进程列表没有其driver／manual helper；不认证远端模型进程状态。本模型子任务App／UI／业务库操作0，仅公开合成资料，根`.env`未回显或提交。

私有证据根 `/private/tmp/notalone-memory-goal-20261013-ac04d687/`（0700／0600）：`diagnostic4/{run-result,run-summary,completion}.json`、`diagnostic4-reviews/`八份完整与紧凑视图、八份显式答复及十六份原clock文件、`diagnostic4-terminal-derived.json`、纯只读收集器`collect_diagnostic4_terminal.py`，原计划、Root激活核验及所有失败保留。completion文件SHA **1708431f13785ee913f32427bae2635afec0159a0cf83de8514c8420794a0a86**，summary **c9c634b4a0647ef0e94a3fbb6484775bc341c41d510d3434b359df881065b831**，result **1dcdc3701a7ac037fc99bd61a4080281122a355f023e5d5ff054f39258fe3cdc**；派生终态SHA **075f0173fc87709864c396d0d083d1cdc7bfadba6bd8859b474e28d79a320dd4**，只复算原封存判断、固定SHA及元数据，不替代原摘要或新增语义标注。

八个run实际SQLite全部closed，累计真实HTTP **42**，收到 **38个200**，旧4次read_timeout远端是否完成仍未知。七个有原driver单调计时的stage合计 **2605.743067667秒**；另一次第三基线只有文件mtime跨度642.991830958秒，不能混称单调时长。总cap480中，42实际消耗、145关闭未用永不复用、12永久退役不注册、全量280及余1未启。没有第四基线或自动后继授权。

原07仍缺≥15现行指代质量门及全量回归；核心01的真实严格6/12／可选2/6不由这四窗改写，B01/B02未选；维度03的质量证据、三类可推导键与四类缺typed依据分别保持，默认空表和逐类批准条件不变。下一步可执行项是据A01／A02／A04实际失败定位来源及语用规则冲突，形成最小提示修复和公开跨例负控方案，并核完整140窗实际入口、Gold及审核装配差距；本结果不是外部阻塞判定，后继源码和调用仍待Root范围核验。
