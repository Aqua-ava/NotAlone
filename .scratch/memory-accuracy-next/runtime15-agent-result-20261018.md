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

## 提示修正后的独立场

源码 `be5d9245` 经独立Standards／Spec增量审查均0实质问题后，新建 `f45e22ab-c5f8-41d2-b9fa-9794b5e30c4a`，冻结SHA256 `8b8ea91ad3c3817bbb8ea60cbb618a7e0bb1400ec1f224dc285e689e5841fb63`。仍为原15窗、同一Gold和最多30次HTTP；不是恢复旧预算。

首窗E／V各返回一次200，预约2/30、零重试。V的1574字节响应在现有脱敏记录器处失败，仅保存SHA256 `fd376961e020fc856103b21fed5e386332110d6679041f884f72ecb680a38f7d` 和状态200，`body_not_saved=redaction_unavailable`。没有可重解析的响应正文，不能判断是外层JSON、工具参数JSON还是其他记录异常，更不能声称提示已修复真实proof交付。未补发、未改写或恢复响应。

外层停止码`deepseek_hard_stop`，附`bounded_runtime_failed_task_snapshot_unavailable`及完成收据不可用。原finish保留`closed=false/close_unknown=true`。事后仅只读核对注册库：`closed=1`、关闭标记存在、预约2、in-flight锁空闲、owned进程组已退出；另存绑定run的独立退场记录，不覆盖原finish。余28额度永久关闭。

正式RAW/FULL仍0、七轴0、basis交付0，P01 unknown、后14未运行。来源先独立归档，再经正式删除清理13类残留及隔离库，均为0；实际模型输出生命周期未运行。两场总计4个已知200请求、56个未用额度关闭；不能把两次首窗当作两个合格质量样本。没有第三场或自动后继。
