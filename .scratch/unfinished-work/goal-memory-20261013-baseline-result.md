# 持续目标：当前基线实际技术停止与E片段观察

[冻结v2计划](goal-memory-20261013-baseline-plan.md)经两轴0项与Root逐文件/blob核验后唯一执行，未改21输入、Gold、原生产E/V提示、门槛和默认空放行表。此前技术6次仅覆盖E契约；本次结果证明V路径仍存在技术失败，当前21窗语义基线未成立。

## 实际运行与闭账

- run `058fa1c2-d34c-41c5-9cbb-780e74bdd5eb`，真实HTTP硬上限42；实际单调计时235.861秒、exit1。首事件落盘台北2026-10-13 01:41:44.700，结果落盘01:45:39.968（文件时刻）。
- 固定首窗A01：E实际HTTP200且保留1候选；随后V三次真实尝试均read_timeout，分别为原调用及SDK两次重试。provider_request4、provider_response1、provider_failure3，11事件；没有进入raw审核回调，无full/V语义评分。
- unknown1／unrun20／audited0，completed／empty／failed均0。旧matcher的general_error1是运行失败标记，不是已核验的一般语义错误或零安全错误成绩；完整计划未执行，不能用于原07达标签、核心6/12或维度放行。
- SQLite `closed=1`、requests4，claimed／closed标记存在；完成收据可用、plan_complete=false、quality_certified=false、capture_gaps=[]，记录与收尾错误均null。剩余38永久关闭，不重开或换UUID补齐。客户端与桥进程退出。
- 本目标真实尝试保守上界累计10（technical6＋baseline4），取得200响应7次，3次V超时的远端结果未知；不能把预约或超时当作收到响应。

## 独立E片段观察

停止后从已保存E事件生成独立E-only视图，未读V／程序层救分；mac Agent只读该片段与固定公开Gold，14字段／来源／视图摘要一致。原文两项必需命题（同一未知第三人不在仓库管理岗、在采购部）raw覆盖2/2；没有补人名或任职起点。确定字段缺陷为category、speech_act、assertion_status及interpretation_reason（4项），alternatives含窗外“此前对话”推测，保留unresolved；其余9项通过。完整E契约覆盖0/2。

这只是事后公开E片段抽核：正式audit仍0，accepted/full层未知，不能把机械填充的0当作经过V的拒绝结论。片段报告的quality_certified与official_semantic_audit_run均false，新增HTTP0；没有修改候选、Gold或首次失败记录。

## 技术定位与证据

实际安装OpenAI3.3.1、langchain-deepseek1.1.0、HTTPX0.28.1／HTTPX2 2.12.0。原driver显式timeout60、max_retries2；[SDK官方固定版本说明](https://github.com/openai/openai-python/blob/v3.3.1/README.md)确认超时与重试可配置，默认重试会作用于超时。本次三次V请求body经安全脱敏后完全相同；不能据此断言服务延迟或SDK为根因。[ECNU官方接口](https://developer.ecnu.edu.cn/vitepress/llm/api/completions.html)与[模型说明](https://developer.ecnu.edu.cn/vitepress/llm/model.html)没有为本请求提供响应时延保证，供应商与thinking保持。

- 外部工作目录：`/private/tmp/notalone-memory-goal-20261013-ac04d687/`，0700，文件0600。
- 实际结果：`baseline/run-result.json`；不可变收据：`baseline/completion.json`，文件SHA `db4af7d1e08ac5b523226674902eb3b5c9e699b9eb13a9e8b2969fe73f102fb8`。
- 用户级持久计数：`/Users/local-user/.notalone-memory-evaluations/058fa1c2-d34c-41c5-9cbb-780e74bdd5eb/budget.sqlite3`。
- 片段：`baseline-fragments/00-A01-raw.view.json`、`00-A01-raw.review.json`、`00-A01-raw-only-report.json`、`fragment-manifest.json`；正式`baseline-reviews/`无生成视图，不能冒称原审核阶段完成。
- 原技术输出、5阶段不可变总索引与所有未执行v1计划保留；没有真实聊天、业务库、App、微信、OCR或发送操作。

下一步仅新的[V有限技术诊断](goal-memory-20261013-V-diagnostic-plan.md)，在未启用14预留中明确扣3，原38不借用；获核验后检测同一实际V载荷的超时与客户端因素，不能自动启动21窗重跑或其他模型阶段。三票原未满足验收继续保留。
