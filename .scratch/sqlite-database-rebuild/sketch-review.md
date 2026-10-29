# 完整草图审阅记录

2026-10-29。本记录审计“继续设计，直到产出完整的草图”，完成标准是可以整体审阅的关系与存储设计；正式DDL、实现、性能、真实数据库切换是后续实施工作，不据此宣称已通过。

## 需求逐项核对

| 要求 | 当前权威证据 | 结论 |
| --- | --- | --- |
| 从需求建模、总表及独立理由；旧PG只查漏 | [主方案](greenfield-design.md)逐表卡片、合并/不建清单；[115项旧名称附录](consolidated-legacy-check.md) | 草图覆盖；表数未获用户批准 |
| 字段、主键、真实外键与关系 | [结构化目录](consolidated-schema.json)包含每表field_contract及foreign_key_contracts；主方案展示全部基础列组和附加范围约束；[全表关系图](schema-relations.md)覆盖所有表 | 草图覆盖；DDL实现仍需候选键/触发器验证 |
| owner/contact隔离与稳定身份，不以昵称绑定 | 身份14表的主键、唯一性和授权链；主方案关系图与事务 | 草图覆盖；渠道真实身份能力尚待adapter实现 |
| Q32身份不足隔离；Q33非文字占位；Q35未知排序 | capture_record三态、message类型/空值、来源和去重合同；媒体内容不落raw_payload | 草图覆盖 |
| Q29完整实际过程、版本、删除链；Q36本人/联系人共表 | execution_event/input/source；memory/version/required_message/citation及传递依赖；删除闭包 | 草图覆盖；实际跨存储删除未执行 |
| Q37恢复新增版本；人工保护不可绕过 | memory当前保护与head_revision；memory_decision真实动作；version形成快照和来源继承 | 草图覆盖 |
| 聊天正文不编辑；记忆候选不保存采纳前多稿 | 无message_version、memory_candidate_version；原稿与正式版本分工 | 草图覆盖 |
| Q38固定轮次、冻结输入、手动继续与unknown | run_input/task/step/attempt；operation_item/scope；调用真实生产者、预算与状态流转 | 草图覆盖；未知回执接线仍需实现 |
| Q39回复原稿与编辑稿统一版本；用户亲自发送 | reply_candidate/version/part、selection及request/context；无外部聊天发送Tool或发送任务 | 草图覆盖 |
| Q40场景/画像共表且配套发布 | document/version/block/statement/basis及publication/member；先完成记忆阶段再冻结文档基线与CAS | 草图覆盖 |
| Q41/最新Skill范围 | package/revision与官方文件边界；学习/审核/方法策略排除，原目录保护及待核验 | 草图覆盖，未执行旧功能下线 |
| Q42删除账本、类型化目标、重试和完整复核 | operation/target/check、请求墓碑、渠道排除、存储维护和切换控制面 | 草图覆盖，未执行真实清理 |
| Q43暂缓且不按94/100/54倒推 | 不建material_set/reference；每用途保留真实业务父和直接FK | 遵从；后续可在整体审阅时再决定 |
| 数据库设计理念与表数量问题 | 一事实一粒度、范式与历史快照规则、无JSON外键列表；每表独立理由、合并依据；71业务+4诊断+2元数据 | 完成可审阅草图，数量仍可按实质需求讨论 |
| 媒体Q1–Q11及三实体 | 媒体完整spec、统一目录message_media/media_extraction_attempt/media_file与删除账本message_identity/媒体scope | 已整体确认并整合；不表示实际提取、解码、DDL或文件清理通过 |
| 索引、状态、类型与短事务 | 主方案相应合同及查询索引矩阵 | 草图覆盖，未作负载/SQL执行验证 |
| 单机SQLite文件、启动、升级、损坏和恢复 | node:sqlite/Worker、受控路径、WAL及明确不自动换空库；schema_migration、database_instance | 工程建议已给出，需实现验证 |
| 新空库、旧PG与副本清理、保留密钥/Skill/原文件 | 主方案五步切换、分存储复核；[规格](spec.md)既有授权边界 | 草图覆盖，未执行切换 |

## 最终关系修正

- processing_item非删除唯一性覆盖成功项，阻止换轮次重复处理。
- 当前保护归memory；版本仅保留protection_at_formation。保护动作使用expected_head_revision，避免同正文版本上的并发保护绕过。
- 文档任务在前置记忆阶段完成后冻结accepted_memory/document_revision及publication；捕获后不更新，失效须新run。
- fixed_synthetic需要fixture身份、修订、摘要和核验依据；发送前与受信登记逐字节核验，不凭调用方标签放行。
- 删除目标与复核均归operation；关系图使用实际登记的父子关系，不把删除复核伪装为每目标子表。

## 实际验证与限制

已执行 `python3 .scratch/sqlite-database-rebuild/validate-sketch.py`：核对表名唯一、主键字段及非空、完整基础FK列组和引用键、77张卡片与目录一致、图关系有登记FK、115旧名称完整分类、链接和交接长度。结果：77表、778字段、215基础FK、115旧名称，检查通过。该检查只证明目录一致性，不证明约束SQL、授权语义、查询性能或真实集成。

已有基础合成SQLite探针11/11记录在[探针报告](../../research/sqlite-constraint-results.md)，本轮未重跑，不当作全schema通过。此前独立只读关系审阅的有限结构缺口已补齐。媒体Q11确认后三实体新增并整合；范围候选键、current文件完整定位/身份、有限结果不降级、state/outcome组合及发布/旧文件清理意图同事务均写入约束。

没有修改业务代码，未运行App/微信、读取真实聊天、连接用户数据库、建正式DDL或删除资料。当前另有非本任务.gitignore变更暴露.scratch为未跟踪；本任务不覆盖忽略规则，不把私密历史草稿纳入提交。实施前门槛继续在主方案中逐项保留。

媒体整合检查还核对显式候选键可被复合FK引用、三实体全部出现在图和卡片、capture_record在本地转换分支可空、Q11标记及删除定位扩展；真实SQL、崩溃恢复和资源唯一性仍未执行验证。

最后字段核对：media_file的format/mime_type在staged/erased阶段可空，但发布current/present必须实测完整；非空受管定位在owner内唯一。completed提取必须在完成事务中发布至少一个归属本次执行的合法文件，查看既存文件不伪造新执行；本地转换的旧原始件由input_file_id追溯。以上为逻辑合同修正，未增加表或字段。

## 实施前查证收敛（2026-10-29）

依据主稿技术结论链接的四份一手报告，本轮执行新增SQLite专项11/11（含77表/215FK空结构骨架和提交前后SIGKILL）、媒体目标Electron合成解码/原生格式检查、.dat纯字节7/7及DSH官方空会话探针。全部结果只覆盖报告明确范围；未生成正式77表DDL，未修改业务代码、依赖或访问真实资料。已有11/11基础探针未重跑。

采纳修正：可选FK只对可选组闭合，CHECK不能借NULL放行；租约按pending/running状态唯一，过期接替需新明确操作与CAS；跨行完成条件由事务/触发器保障；runtime_copy.expected_identity在preparing可空，写前必须真实身份，sdk_instance_id是预选SessionId。77表/778字段/215FK不变。

本地工程选择和恢复协议已明确，可独立实施验证。整体真实渠道接线仍受可信世代、规范身份、精确清空屏障后新旧判别和严格资源映射这一组门槛约束；不得因此改写用户已确认规则。图片WXGF是明确unsupported，不伪装已支持。用户本轮只授权查证，未启动实施。

## 微信渠道第二轮收敛

[当前解决合同](../../research/wechat-channel-resolution-v2.md)将门槛具体化为版本身份支持档和单次只读元数据屏障。完整S(B)覆盖本机尚未导入历史，接受后的源切面B固定；不以server_id永久全球唯一为前提，不把未来外部回填或鼠标点击瞬间精度扩大为Q24的已确认要求。旧排除、范围控制及未知身份隔离保持不变。

5组SQLite身份机制断言和目标Electron Session探针通过；仅证明报告所列机制。只查安装包Info.plist得4.0.6/build29387，未读取真实源库；缺该版本结构/生命周期及锁定WCDB原生屏障实测。没有实现、安装依赖或打包。77表/778字段/215基础FK保持不变；候选排除生效与边界接受条件补入现有两表逻辑合同。

回写后执行validate-sketch.py通过；三主稿及四份二轮报告共7文件、75个本地链接存在性与代码围栏检查通过。只验证文档/目录一致性，不等于原生读取、业务集成或隐私全库扫描通过。另一处.gitignore变更保持原样，私密本地草稿未纳入Git提交。

## 四份规格定稿复核（2026-10-29）

本轮在原规格上定稿，保留全部已确认规则和77表／778字段／215基础FK逻辑目录，不改业务代码、依赖、来源锁或当前ADR。统一原生v3的独立observer／reader短获取窗口协议，更新媒体已确认解码路线与证据状态。

复用原生12/12、生命周期合成14/14及既有SQLite／媒体／DSH证据；没有条件变化时不重跑。开发App已恢复并经Computer Use观察；原PG socket不存在，读取开关和选择范围无法核验，因此当前真实结构检查仍受阻，未读取微信。真实发送／撤回未执行；用户本轮明确不再考虑迁移／恢复实验，该能力保持未验证。

行为规格定稿与能力放行分开；State保持open，ready-for-agent仅指可供后续拆票。真实支持档、最终制品、完整DDL、产品接线及跨存储故障验收依旧必须按各项完成。详见[本轮验证记录](../../research/wechat-spec-finalization-validation.md)。
