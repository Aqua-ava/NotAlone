# 01：保真评测的离线逐例报告

State: resolved
Triage: ready-for-agent
Blocked by: None (can start immediately)

拆分标识：E01（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧01；评测协议。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)。依赖是完整交付的前置，不代表这些前置已完成；发布时尚未实现；当前完成证据见 Answer。

## What to build

从带事实、意图、未知项和开发/保留划分的合成案例及受控输出生成可审阅报告。

## Acceptance criteria

- [x] 离线输入包含当前意图、可用事实、未知项、允许变化及开发/保留划分；预期答案和标签不进入生成输入。
- [x] 逐例分别记录确定性契约结果、人工语义审阅及依据、未审阅/未知；人工标注不能伪装成程序自动判定。
- [x] 用故意错误、缺失和超时响应验证报告保留失败、分母、原输出、配置/数据版本、耗时与调用计数；未知不记通过、超时不记零成本。
- [x] 旧原型只作开发回归，保留集不用于改提示后又称未见；硬性保真失败不被自然度平均分抵消。
- [x] 首轮只用合成输出验证评测流程，不执行真实模型调用或宣布真实自然度、用户相似度达标。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

区分确定性契约失败、带依据的人工语义审阅和未审阅/未知；错误夹具验证失败记录与报告，不声称脚本自动识别语义。分母及输出可追查，旧原型只作开发集，不执行真实模型调用。

## 验证与交付

使用离线评测公开入口，输入合成案例、受控输出和明确的审阅标注；验证报告、分母、失败与未知的传播，不依赖真实模型、App或数据库来测试报告流程。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

2026-10-11 完成状态证据复核：持久交付[16例离线报告](../reports/offline-controlled-v1.json)。在backend／Conda NotAlone运行 `PYTHONPATH=src python -m notalone.reply.fidelity_evaluation --dataset tests/fixtures/fidelity/synthetic-v1.json --run tests/fixtures/fidelity/controlled-v1.json --output ../.scratch/authentic-expression/reports/offline-controlled-v1.json`，CLI exit0；三个报告相关模块 `test_fidelity_evaluation`、`test_fidelity_review_details`、`test_fidelity_capture` 共7项GREEN／2.395秒。报告4开发／12保留，16分母、2契约失败、14故意错误显式合成标注、2未审阅，保真失败14、真人通过0。原v1标注未提供reviewer_kind，机器来源统计按unknown保留16，未擅自补成人工或新审阅；每例reviewer原文仍表明合成夹具。15调用／1640ms只是原夹具数据，本轮CLI零模型调用，缺失成本1使总成本保持null。原输入及标注未改；7条验收标准按源码、公开CLI输出和测试证据勾选，不代表真实模型质量验收。报告与状态文档最终Standards硬要求0／重要Fowler0、Spec新增P0–P2为0。

## Answer

2026-10-11：自动实现与验证完成。新增 `notalone.reply.fidelity_evaluation` 离线公开入口、16例合成开发/保留语料与故意错误输出；报告保留原输出、超时/缺失、逐维分母、显式标注依据与未知成本。生成输入不含标签、答案或划分，同句不同前文保持共同原句。模型及提示版本必须非空。仅合成输入，无业务存储、新外部调用、实际发送或私人日志。

实际命令：激活 `NotAlone`，`PYTHONPATH=backend/src python -m unittest tests.unit.reply.test_fidelity_evaluation -v`（在backend执行时PYTHONPATH=src），3项通过；离线CLI输出分母16、契约失败2、合成标注14、保真失败14、未审阅2、已知调用小计15/1640ms、未知成本1，总成本未知。Standards独立审查0；Spec提出5项报告真实性问题，均以相应公开CLI反例修复。

本票离线交付不需要真实模型或人工质量验收；真实语义、自然度与用户相似度仍未验证，不把故意错误合成标注描述为真实质量审阅。普通页面、App和微信未运行。

总协调主树独立复验：激活 Conda NotAlone、关闭 dotenv 与外部追踪，原公开 CLI 以同一 synthetic-v1／controlled-v1 生成临时报告，实际 exit0，完整 JSON 与正式持久报告逐项一致；本轮模型、网络、数据库及页面调用均 0。三个报告模块共7项 GREEN／0.378秒，fixture 原计量与本轮调用明确分开。新增三文件最终 Standards 硬要求／重要 Fowler 可能气味 0、Spec 0；未据此关闭 E04–E06 或宣称人工语义质量。
