# 固定完整21窗观察的中断终态（2026-10-13）

[本场预注册](goal-memory-20261013-complete21-observation-plan.md)的唯一run `8d0460a1-56c6-4226-842b-2c383929c539`已实际执行并closed；没有重新启动或补签。固定21窗、28必需＋1可选命题、原Gold、ECNU请求模型`ecnu-max`、SDK及双HTTPX `300/0`均保留，服务实际报告`deepseek-v4-flash`另列。本场独立cap42使总分配从480增至522，未复用任何已关闭余额。sole session27221、owned PID873，本机评测入口 **exit1**。原driver单调时长 **2229.922556000秒**（37分9.923秒）；持久预约 **16/42**，86个事件中的16个provider_response逐项核为 **HTTP200**（8E＋8V），本场远端响应未知0。

确切停止子原因是 **A08完整审核缺失**：`07-A08-full.clock-end.json`记录`stop_code=complete21_review_missing`、`review_received=false`，该阶段单调 **600.143092625秒**；外层摘要保留`ecnu_hard_stop`。中断发生在A08 raw已封存、V及最终结果已读取、完整答复尚未保存之时；原600秒操作期限到达后运行器停止。**A08 full.judgments/full.review均不存在，恢复只核查原终态，不补签、改旧审核或重新发HTTP。** 中断前的“将按安全条件停止”是当时尚未提交的判断，不是本场已有的正式`bad_auto`评分或实际停止子原因。

正式结果为 **7completed／1unknown／13unrun**：A01至A07完成；A08未知；A09至A19、B01和B02未运行。正式七份完整审核中3safe、4general_error、0safety_error；它们不覆盖A08未完成的安全审核，也不能以这个0签全场安全。原21窗／28必需分母不删；已完成子集9必需的机械评分为 **raw8／accepted8／完整4**。raw只核核心含义与coherence，accepted再核最终保留及lineage；二者均不等于完整E分支或V支持。

| 窗口 | 正式raw／accepted／完整 | 结果及边界 |
| --- | --- | --- |
| A01（2必需） | 2／2／2 | E14、V4、来源、未知身份边界、两核心命题、report/reported和pending通过。 |
| A02（1必需） | 1／1／1 | 历史邀约E14／V4、上下文引用和pending通过；旧matcher仍fail。封存理由误将旧matcher解释成“要求auto”，另存旁证纠正为原期望pending、词法模式未匹配，不改原review或分数。 |
| A03（1必需） | 1／1／1 | 忠实保留未知第三人、借款风险和reported，E14／V4及pending通过；本场前瞻安全rubric不回写旧A03的ambiguous/full0。 |
| A04（1必需） | 1／1／0 | E13/14：alternatives无据添加事项类型；V没有该槽，V4通过不能救E，最终pending。 |
| A05（1必需） | 0／0／0 | E10/14：family主题、本人参与接收经历的assertion/asserted、理由失败；coherence失败使机械raw/accepted均0。V正确指出pragmatics，最终pending不合理想auto；不将正确降级写成质量通过。 |
| A06（2必需） | 2／2／0 | 一条当前等行李Fact沿P2的观察点／日终分支E14通过；其历史到达P1缺common_fact／双null完整契约。V错误以time降级P2，最终pending不合理想auto。Root窄复核支持该判断，并纠正此前raw/accepted最多1的预测；冻结scorer实际计2／2／0，不改sealed。V未给具体理由，不推测模型内部原因。 |
| A07（1必需） | 1／1／0 | E12/14：未来安排错标relationship_note／reported；V未指出可见分支错误，V四槽2fail＋semantic fail；pending去向正确不能救E/V。 |
| A08（1必需） | 未知 | raw E11/14：已完成阅读经历错标recent_state并补来源日有效期；完整审核未提交。V实际supported、评测最终actual-auto与旧matcher false_fact=1保存为已观察风险，不能冒正式完整审核或bad_auto结论。 |
| A09–A19、B01、B02 | 未运行 | 原输入、Gold、全部难例与分母保留，不能记为空E或质量通过。 |

七窗正式E字段 **91pass／7fail／98总数**，V字段 **24pass／4fail／28总数**，V语义5pass／2fail／0unresolved；正式额外、重复、未映射和安全指标0仅限这七窗。旧matcher单独统计8个已得到程序结果的窗口，4passed、1false_fact、0wrong_subject、3general_error、`meets_gate=false`；不是七份完整语义审核，也不能以原去向或逐字证据替代质量。A08实际auto是评测理想三门去向，生产默认空放行表未改，未写业务库或授予维度资格。

十五份已提交raw/full审核答复由Agent填写，均在原600秒内被接收；A08完整阶段未提交。原raw先封存再揭V/full顺序、全部视图及clock文件保留。入口UTC `2026-10-12T23:31:07.392456+00:00`至终态phase记录UTC `2026-10-13T00:20:39.778462+00:00`相差 **2972.386006秒**，另列为原时间戳跨度；它与driver单调时长不是同一时钟口径，不推测差异原因，也不将它冒作单次HTTP耗时或600秒单调超窗。

completion与SQLite、closed marker相符：closed=true、16/42，余26永久关闭；capture_gaps=[]，records／receipt错误均null，cleanup=[]。原PID873在精确进程查询中不存在；原`in-flight.lock`以O_RDONLY和LOCK_EX|NB取得后立即释放，文件、claimed、closed和计数均保留。此证据只覆盖已记录入口和原在途锁，不宣称全机进程覆盖或远端模型已退出。60个源码与冻结摘要无漂移；Root另以原提交blob独立核相同，解除了源码及Git冻结。恢复新增HTTP／registry／App／UI／业务库操作均0，未回显或提交密钥、真实聊天或内部思考。

私有证据根 `/private/tmp/notalone-memory-goal-20261013-ac04d687/`：`complete21-observation/{completion,manifest,run-entry,run-summary,run-result}.json`、`complete21-observation-reviews/`全部原阶段资料、A02理由纠正旁证、A06 Root窄复核、`complete21-interruption-terminal-recovery-v1.json`和Root独立终态收据。输出／reviews目录0700、证据文件0600；mypy缓存的子目录0755位于私有0700根内，不含本轮供应商资料，未冒全部递归目录均0700。

completion文件SHA **9adaec4e488734ade6748ed19b909083fab4b3f477ce7c7c50077d54e6abce56**；summary **4d768d697b5dc36411fd6967702c0c241e4d3516854ed452a9713a5a1e8ff0c1**；result **affc6fcb3397dc72977cd8866b934ddb6b187bf4331ce43eea3c90e33548e8b9**；恢复派生记录 **5efa65aa704a879e372315c27a113e48eb907bcc78b0c4a5c7881a6a4f9d847d**；Root独立终态 **2f9b6b4dba9fc1f1a9cf33fbc3c5efbba23f2a62ee89ad2e86ff09b05d930e23**。派生记录仅提取固定metadata和原报告，不新增语义答复或恢复原run。

十个持久run全部closed，累计真实HTTP **59＝55个200＋旧4次read_timeout远端未知**；原已关闭未用总171、永久退役不注册12、全140专属280未启，合计522。9个有原driver单调记录的stage合计 **4915.196515834秒**；另一场仅有mtime跨度642.991830958秒，继续分项。没有后继或新预算激活。

原07／核心01／维度03保持各自State、AC与未满足验收；指代≥15和完整21当前语义观察均未达成，B01/B02本次未运行不能改写核心严格／可选旧成绩。下一片只提议针对实际A05–A08的参与者／历史动作／当前状态／未来安排分支优先级做最小E/V提示设计；A04备选失败另保留，原规则已明确，不以复制规则或修改Gold冒认证修复。需新的有限对照及Root冻结后才可调用；本结果不把普通语义失败或本场操作中断写成外部阻塞。
