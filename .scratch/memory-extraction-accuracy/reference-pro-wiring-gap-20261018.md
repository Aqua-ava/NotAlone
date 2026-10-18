# 任务07的新模型验收接线差距（只读盘点）

2026-10-18。目标仍为原主16窗假事实0、错人0、一般错误≤1、歧义不auto；[最新实测](reference-agent-fewshot-result-20261018.md)未达标。本文没有新预算、冻结或调用，不把后续配置准备当验收通过。

## 已核实的接口差异

| 接缝 | 当前证据 | 后继约束 |
| --- | --- | --- |
| 输入集合 | `cases/reference.py`原16；D8使用独立Gold的来源时间。旧一次性装配逐窗冻结完整Window，主16与D8分别统计。 | 保留24窗原文、顺序、target和来源时间；不借bounded15身份、cap30或Gold。 |
| 执行协议 | 旧场E2＋legacy-v4，E/V均disabled/none；`evaluation_ecnu.py:567`旧主16入口固定另一组协议。 | 新增任务07专用闭集配置，不能仅改旧入口的model。采用新V或Emax须明确为组合交付验证，不能称仅模型对照。 |
| 正式Gold | `evaluation_reference.py:208`起的公开来源保真注册固定21窗；当前主16是其中A01–A16，D8为另一结构。 | 主16不重标；如采用正式审核器，可新建机械投影及D8转换副本并独立逐项核对，保留原Gold及摘要。 |
| 审核格式 | 旧装配为结果SHA绑定的五字段Agent回执；`evaluation_review.py:202`要求逐字段、命题及窗口审核。 | 五字段回执不能冒充正式RAW→FULL；新格式使用原固定口径，旧可见E/V审阅不追认为盲审。 |
| 审核桥 | `desktop/tests/fixtures/explicit_review_bridge.py:95`绑定run/phase/case/nonce/view摘要；`evaluation_phased_audit.py:90`约束RAW不可由FULL重写。 | 可复用桥和600秒等待；不得把V supported或旧matcher当来源语义签核。 |
| 请求核验 | 旧临时装配有硬预算、记录器和响应model检查，但没有传入正式逐请求合同；`evaluation_ecnu.py:850`使用expect_request。 | 新profile在发送前核模型、思考、工具、提示/schema及实际输入，不借旧宽装配绕过新闭集。 |
| 模型身份 | 官方profile当前固定Flash；拟议Pro bounded15专用于另一组固定任务，尚未实现。 | 由runtime owner扩展专用登记和精确响应校验；响应漂移立即停，不接受任意别名，不宣称返回名证明权重。 |
| 额度与期限 | 旧24窗cap48、零重试；新bounded15设计cap30及不同期限。 | 任务07独立登记并闭账，不复用其他场额度；主16/诊断8继续独立分母，未运行不删除。 |
| 凭据和进程 | 正式路径还含records、owned领取、prepare/validate/worker/launch及凭据helper。 | runtime owner贯通这些入口后，离线验证拒绝路径与清理；prepare不读凭据，领取后才读取显式私有密钥。 |

路径除明确fixture外均相对`backend/src/notalone/memory_extraction/`；行号对应盘点时已有Flash实现，新接线后应按符号复核。

## 费用边界的新发现

`backend/src/notalone/reply/adapters/deepseek_provider.py:58–125`的builder不提供max_tokens；旧24窗装配也未传该字段。因此旧cap48仅是调用次数上限，研究里按既有usage计算的价格只是参考。官方未指定时非思考默认8K、max思考默认128K；见[API定义](https://api-docs.deepseek.com/api/create-chat-completion/)及[研究](deepseek-config-options-20261018.md)。新配置必须如实冻结字段缺省，或明确新增输出上限并核验实际SDK请求；不能把次数上限叫作token/费用硬界。

仅重扫旧响应usage字段：Emax旧场29次总输出20133、单次最大5237；最新fewshot41次总输出5128、单次最大272，两场均无超过8192的响应。这支持历史样本未触及新上限，不能保证Pro或新增逐码点输入不会超限；未读取或打印推理正文，未新增请求。

## 分工与下一步

盘点后runtime owner已将其Pro-only设计明确为E/V各max_tokens=8192；实现中、尚无真实外发，30次对应245760仅是输出token上限。该组合同时包含模型、逐码点辅助和输出上限，不作单变量归因。

runtime owner先完成其bounded15专用Pro接线；任务07随后单独审定闭集，不扩大其通用profile。指代分支可准备原输入投影、D8正式Gold副本和审核适配的离线核对，但需先确定执行协议，当前不改共享文件或启动批次。研究的96次双臂方案仍只是建议，不是已定计划；若目的仅验证当前组合交付，无需为因果比较额外重跑Flash。

本轮由独立Agent核对正式runner与旧临时装配差异；没有读取核心私有6/4留出正文、真实联系人、凭据或业务库，没有模型请求。原任务State、Gold、失败记录、默认生产空放行表保持。
