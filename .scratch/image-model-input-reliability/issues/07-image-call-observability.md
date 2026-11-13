# 07 图片模型调用可观测性

Triage: ready-for-agent
State: resolved
Type: task

- 范围：每次模型调用的追踪记录图片 id、原始字节、发送字节、张数、请求总字节、失败类别、耗时；不含图片与聊天内容。接入统一诊断日志（commit `57b0c1611`），避免另造日志通道。
- 约束：只记元数据；失败类别沿用 issue 03 的脱敏分类，03 未完成前先记 `providerCode` 与耗时。
- 测试：追踪记录不含内容；字段完整；日志不外发。
- 完成条件：写入 `## Answer`。

## Comments

## Answer

可观测性工程、日志删除闭包及追加真实合成调用的即时导出核对完成；最后一次L3业务核验仍未通过，整体阶段6部分通过，

本地提交c6f98ebed、e0a2d8667及7147c2a62。普通和strict调用使用现有统一日志processing.model_call与processing.model_image，共享trace/callId，记录图片ID、原始/发送字节、尺寸格式、图片数、最终请求UTF-8字节、阶段、失败枚举和耗时；发送前失败也有脱敏元数据。日志不含正文、图片/base64、图片摘要、凭据或原始cause，不另造通道。业务来源追踪保留原file_id/sha256及发送摘要，不保存派生图片。

正式DeletionService稳定排空旧调用、擦除受管文件后，结案前清除该图的待写事件和main/backend逐图日志。失败以diagnostic_image_cleanup_failed保持blocked且可沿原操作恢复；保留无图片身份的汇总和独立图片记录，清除屏障证明也保留。

工程验证：模型/provider/统一日志50/50；单图擦除/合同24/24；正式删除/媒体/诊断42/42（含SQLite删除集成3项），覆盖两通道、字段完整、防泄漏、跨进程及待写清理、失败恢复、联系人删除和独立资料保留。原生请求身份/响应头与TIMEOUT21项及22项通过，类型检查通过。e39bf0930规范化profile/隔离8项通过；4498fc52b条件式HTTP断连与transport组合22/22。各次运行不累加冒充独立测试总数。

真实L1：样本14/14有成功图片追踪（本轮9、既有5），本轮六次新调用已知且结算、sample unknown0；原失败图E/V实际发送1134×1512 JPEG207,252B，原sha256匹配。Computer Use已核对本轮9图、35文全部成功。原L1统一日志已按有界策略滚动，不能补造或宣称仍能逐项复查旧日志；SQLite来源/发送追踪和账本证据与日志回溯限制分别记录。

为验证当前正式日志接线，追加一轮真实合成E/V两次调用后立即导出：2个call汇总、2个image事件；全部要求字段完整，missing0、内容泄漏检查0、writer rejected0/dropped0，隔离资源已清理。该结果证明本次调用日志通道可用，不冒充原L1历史日志存档。阶段6合成调用累计4次。

最终同一问题账本46次预留：阶段0保留8、合成4、样本34（L1新增6、裁决16、L2三次、L3三轮共九次）；未重置期限或次数。旧stage6独立复核按图片目标改善/L3未通过结案，同ledger唯一续作stage6-l3-contract的三次额外额度已全部用尽，硬cap46/parent96，禁止第4次请求和任何未授权续发。

隔离重试Computer Use闭环已通过；最后一次L3仍未通过，临时接线/.env已核对还原。已结束命令auto0与调用/范围审计通过。临时隔离视图已完成Computer Use点击闭环：1隔离转pending1/等待提取、隔离提示和按钮消失、成功0；无真实POST或模型调用，控制器CAS已还原。

阶段6最终真实结果：图片L1有14/14成功证明（本轮新处理9张、既有5张），真实处理卡9图/9图和35文/35文已通过Computer Use；L2 gen3真实published/succeeded。L3 gen4失败document_contradiction_basis_missing、gen5失败document_profile_unverified；a25dc2a8c修复矛盾引用exact2合同后，用户限定的最后一次gen6仍失败document_profile_unverified，未发布L3。模型调用及预算事实不等于业务核验或发布成功，整体阶段6只能判部分通过。

a25dc2a8c新增8项及既有L3 workspace11项，是实际四文件22项组合中的19项相关绿，不是单独执行19项命令；组合21通过1个旧失败，typecheck通过。另有4个基线失败（3旧裁决reason、1 profile unknown shutdown）已在frozen HEAD与mergeMain930后复现不变，不宣称全suite通过，不因此放宽核验。

最终安全快照：最后一次L3三次调用额度已用尽，同一问题账本累计46次预留/父总上限96；续作stage6-l3-contract执行硬cap46，active0、finally auto0，未新增unknown。全库新增样本调用34次，非样本及无法证明归属计数0；sample unknown0，其他范围原4条unknown不变。14图仍为9新+5既有。不得再发模型、不得放宽guard；任何后续真实复验需要新的明确授权。新round stage6-l3-contract按unchanged结案，旧stage6仅图片目标判improved；最终集成/清理已完成，见下方元数据。

最终独立复核：gen6的16条画像核验为15 supported、1 unsupported inference，guard未放宽；3次模型调用全部succeeded/settled、效果占位已释放、active0，所以新round以unchanged结案，未发布L3。当前L2发布7个scene、0个profile。新增样本34次调用均succeeded/settled，foreign/unproven0、sample unknown0、其他原4条unknown不变、auto0；独立只读副本已删除。

最终集成与清理：main已快进到7d3ab2227，原3项WIP内容SHA完全保留；4份验收TEMP逐项与HEAD校验后还原，controller CAS clean。工作树.env软链接已删、main.env未改，工作树tracked clean，main status仅原3项WIP。backend与desktop typecheck均退出0；最终公开历史扫描覆盖3532 commits/26047 blobs/2061当前files、issues0，diffcheck0。已恢复main普通pnpm run dev（无acceptance/budget/manual/UI临时环境），HTTP与Computer Use均确认总开关关闭，CUA已正常结束。验收私有临时空间仅保留权限600的budget.sqlite，无图片或用户库副本；工具/备份目录、工作树自有.dev/app均清理。不再调用模型。
