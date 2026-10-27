# 统一记忆处理合同

本模块提供 ADR-107 的范围状态、历史、持续暂停／继续和固定轮次执行。安全中断的受阻范围可直接继续，无须先暂停。控制复用真实任务与唯一 Worker；启动自动恢复由后续任务接入。

- `GET /api/contacts/:contactId/memory-processing/state`：只读取认证本人及指定联系人。
- `GET /api/owner/memory-processing/state`：只读取认证本人且 `contact_id IS NULL`，不依赖选中联系人。
- 对应的 `/history?cursor=...` 独立分页，每页最多 20 条。游标绑定认证本人、联系人范围及微秒时间边界；不支持任意查询条件。

- `POST /api/contacts/:contactId/memory-processing/{pause|continue}` 与本人对应路径接受 `{action_version,operation_id}`；版本由状态顶层 `action_version` 取得，操作标识是 UUID。
- 响应 `{accepted:true,operation_id,action,action_version,control_generation,replayed}` 只确认控制意图接纳；调用方随后重新读取状态。同一标识和请求体重放返回原接纳回执，不再取消或唤醒。
- 过期版本或同标识不同请求返回 `409 memory_processing_state_conflict`；当前不能安全继续返回 `409 memory_processing_continue_unsafe`。暂停后的未决／未知调用、未消费 A 段、来源失效、不可恢复失败或仍需模型但额度耗尽时均不授予继续动作；仅消费已成功回执的确定性收尾无需增加模型额度。

旧 `/memory-processing` 和 `/resume` 是隔离的兼容合同，新的本人页面不调用它们。旧 owner 宽查不能作为本人状态或动作的依据，后续兼容收口任务负责退役。

## 持久身份与执行归属

迁移 `124_memory_processing_lifecycle.sql` 只建立空表，不回填旧任务或控制意图。

- `memory_processing_scope` 以 `owner_id + scope_kind + scope_key` 唯一标识范围；`contact_id=NULL` 表示本人。`control_generation` 是范围控制代次，`intent` 只记录明确接纳的 `run/pause` 意图。
- `memory_processing_round` 以 UUID 和范围内 `round_number` 标识有限轮次；其 `control_generation` 记录轮次取得的控制资格，与轮次序号及内部步骤租约代次不同。`target_unit`／`target_count` 保存本轮可读取的可靠数量，不用任务后来追加的目标覆盖。
- `active_round_id` 指向同范围当前轮次，完成后保留该身份，下一轮接纳时切换。只读查询不会补建该指针。
- `memory_processing_round_task` 通过复合外键及类型检查绑定真实业务任务。任务允许保留多个历史归属，但部分唯一索引禁止它同时属于两个有效轮次；任务重用前须撤销旧有效归属。
- 迁移 `126_memory_processing_round_targets.sql` 增加轮次消息目标快照。首次接纳任务时冻结当时尚未归轮的合法目标；同一任务运行中新增的目标不进入当前轮次，并作为后续等待集合可由状态读取。

范围及轮次元数据随本人／联系人删除级联清除；不保存聊天正文、联系人名称或供应商凭据。

## 读取语义

当前状态读取范围控制、当前轮次及其有效任务归属／真实租约，按已暂停、处理受阻、处理中、等待处理、已完成排序。当前状态不依赖历史列表是否截断。没有执行者的工作不能冒充正在处理；旧失败、取消或暂停也不能冒充用户的持续暂停。

旧工作没有可信轮次时保留中文归属待核对说明，保守呈现受阻且不授予执行资格；可信当前轮次存在时，旧任务只在历史中展示。聊天计数只取实际消息计划，不累加不同任务、记忆或步骤；无法确认的数量保持 `null`。

状态和历史读取使用同一只读快照。首屏历史失败用保存点隔离，返回可用的当前状态及 `history.error`；独立历史请求失败返回 503。当前状态读取失败返回 503，不把读取故障写成业务失败。主卡中文原因只来自安全类别映射，原始技术码与内部编号只用于详情。

正式 profile、隔离 PostgreSQL／真实 Worker 的轮次验证见 `test/memory-lifecycle-round-host.test.mjs`，覆盖固定目标、零候选、逐条拒绝、主题／画像衔接及画像单独恢复；跨后台和真实页面的验证见 `desktop/tests/memory-processing/round-http-pg.test.mjs`。夹具只配置合成密钥，网络守卫禁止外部调用；这些通过不代表真实模型或原生 App 已验收。

当前轮次只在全部真实任务成功、消息目标均有合法完成回执且没有未完成目标时结束。主题成功而画像失败会保留主题结果并显示受阻；继续只重开同一成功批次后的画像阶段，不新建轮次、批次或预算。新任务自动接纳下一轮和启动扫描分别由后续任务接入。

## 暂停与继续的执行围栏

迁移 `125_memory_processing_control.sql` 增加无正文操作回执和步骤的 `memory_control_generation`。控制事务按联系人锁、本人锁的顺序串行；暂停推进范围代次并撤销所有记忆在途租约，再按原步骤身份与租约代次尽力中止匹配执行并最多等待本地排空四秒。供应商是否停止和实际费用只由原调用回执表示。

领取、A 段、采纳提交、主题、画像和模型预约共用范围资格。暂停后迅速继续也不能使旧代次／旧租约结果重新合法。已有调用的 `recordReserved` 结算独立于执行资格。回执检查仅使用真实记忆任务、冻结批次及最小来源关联对应的请求，独立回复与 Skill 的未决回执不阻止记忆继续。继续只复用原来源、成功步骤、回执和累计预算，不调用会重置尝试次数或补额度的旧恢复动作。自动观察通知、旧恢复、旧主题 enable/refresh/continue 和维护调度均不能解除持久暂停；同步保存、来源删除和 Skill 不受该门禁限制。

正式 HTTP、实际 Worker 和环回供应商时序验证见 `test/memory-lifecycle-control-host.test.mjs`。测试支持的 `restartHost()` 重建同一合成库、同一本人与正式 profile，用于验证暂停持久性；它不为产品新增测试端点。
