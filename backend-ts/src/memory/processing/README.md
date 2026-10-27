# 统一记忆处理查询合同

本模块交付 ADR-107 的只读状态与历史，不提供暂停、继续、建轮次或 Worker 唤醒能力。控制动作由后续任务接入；当前响应的 `actions` 固定为空。

- `GET /api/contacts/:contactId/memory-processing/state`：只读取认证本人及指定联系人。
- `GET /api/owner/memory-processing/state`：只读取认证本人且 `contact_id IS NULL`，不依赖选中联系人。
- 对应的 `/history?cursor=...` 独立分页，每页最多 20 条。游标绑定认证本人、联系人范围及微秒时间边界；不支持任意查询条件。

旧 `/memory-processing` 和 `/resume` 是隔离的兼容合同，新的本人页面不调用它们。旧 owner 宽查不能作为本人状态或动作的依据，后续兼容收口任务负责退役。

## 持久身份与执行归属

迁移 `124_memory_processing_lifecycle.sql` 只建立空表，不回填旧任务或控制意图。

- `memory_processing_scope` 以 `owner_id + scope_kind + scope_key` 唯一标识范围；`contact_id=NULL` 表示本人。`control_generation` 是范围控制代次，`intent` 只记录明确接纳的 `run/pause` 意图。
- `memory_processing_round` 以 UUID 和范围内 `round_number` 标识有限轮次；其 `control_generation` 记录轮次取得的控制资格，与轮次序号及内部步骤租约代次不同。固定目标与来源／回执快照由后续轮次执行任务补齐。
- `active_round_id` 指向同范围当前轮次，完成后保留该身份，下一轮接纳时切换。只读查询不会补建该指针。
- `memory_processing_round_task` 通过复合外键及类型检查绑定真实业务任务。任务允许保留多个历史归属，但部分唯一索引禁止它同时属于两个有效轮次；任务重用前须撤销旧有效归属。

范围及轮次元数据随本人／联系人删除级联清除；不保存聊天正文、联系人名称或供应商凭据。

## 读取语义

当前状态读取范围控制、当前轮次及其有效任务归属／真实租约，按已暂停、处理受阻、处理中、等待处理、已完成排序。当前状态不依赖历史列表是否截断。没有执行者的工作不能冒充正在处理；旧失败、取消或暂停也不能冒充用户的持续暂停。

旧工作没有可信轮次时保留中文归属待核对说明，保守呈现受阻且不授予执行资格；可信当前轮次存在时，旧任务只在历史中展示。聊天计数只取实际消息计划，不累加不同任务、记忆或步骤；无法确认的数量保持 `null`。

状态和历史读取使用同一只读快照。首屏历史失败用保存点隔离，返回可用的当前状态及 `history.error`；独立历史请求失败返回 503。当前状态读取失败返回 503，不把读取故障写成业务失败。主卡中文原因只来自安全类别映射，原始技术码与内部编号只用于详情。

正式 profile、隔离 PostgreSQL／真实 Worker 的 HTTP 验证见 `test/memory-lifecycle-state-host.test.mjs`；跨后台和真实页面的验证见 `desktop/tests/memory-processing/http-pg.test.mjs`。夹具只配置合成密钥，网络守卫禁止外部调用；这些通过不代表真实模型或原生 App 已验收。
