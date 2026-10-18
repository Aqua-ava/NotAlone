# 有限运行依据真实首场与提示诊断

Triage: ready-for-agent

2026-10-18，新场 `a4a18315-ffdc-4e49-a71a-9b789d4f885b` 使用实际合成来源、指定任务及已批准15窗合同；源码冻结包含核心依赖修复 `2cfe0a4b`。冻结文件SHA256为 `0e35331434e7850c69d2fdea8da218ec344765b0a342be004988981f216054d8`。本场单独计数，不拼旧场或另两票的分母。

## 实际结果

- 首窗P01的E、V均返回官方`deepseek-flash` HTTP 200，共预约2/30，SDK与传输重试0。V提案来源区间`[0,7)`超出实际6码点，候选区间`[6,13)`误含开引号；严格核验拒绝。`reference=null`本身符合可空合同，但不足以提供自指关系依据。
- 外层停止码`deepseek_result_unknown`，内部为`formal_task_first_execution_failed`、`verification_contract/proof_semantics`失败、`invalid_output`；不是网络超时或未取得HTTP响应。候选没有进入adoption/write，不把V supported签成依据。
- 正式RAW/FULL审阅0、七轴成绩0、实际正向basis交付0；P01 unknown，其余14窗unrun。独立审核Agent确认audit目录无视图，未生成任何审阅或pass；身份`reviewer_kind=agent`登记于绑定run/freeze的元数据。
- 本场已closed，余28额度永久关闭，owned worker已退出。先归档来源与追踪，再执行正式来源删除；13类残留均0、自有隔离库残留0。实际输出生命周期因缺交付未运行，沿既有工程Mock证据分报。

## 离线诊断及下一步边界

封存V响应在同文本、E2实际编译与ALL合同下离线重放，原区间仍拒绝；仅修正位置的人工合成对照为UNKNOWN/proposal_not_matching，补齐作者自指链接后为verified。这只是确定性规则诊断，不改真实响应、不中途修复提案、不增加本场质量计数。

仅在nullable-proof-v3提示补充0基Unicode码点计数、完整候选字符串偏移、内文与包装边界及作者自指链接说明；不改schema、解析器、有限语法、默认模式或放行门。27项bounded proof单元检查通过。提示是否改善真实交付须在新冻结场独立验证，不能由合成对照代签。

生产放行表保持空。本票原AC与State继续保留；没有业务迁移、真实联系人读取、桌面或聊天发送、远端Git。为独立工作树准备仅官方模型三字段的0600本地配置，不输出凭据；模型loader在领取后读取该受控文件。
