# 物理模型调用接线审计

2026-10-24，只读审计；未修改产品、运行模型或真实资料。用于05实施与主宿主装配，不是完成验收。

- 固定DSH `0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`；官方 `packages/llm/llm/src/index.ts:1166` 将stream交给adapter，不提供Python任务与预算传播。
- 已确认：`model-ledger.ts:86`原将旧投影outcome当不可变身份，unknown已观察响应投影失败后，迟到成功在details前冲突。只以内存client复现，不宣称PG回归；05负责修复与真实测试。
- 已确认：官方 `llm-deepseek/src/adapter.ts:138` 非2xx直接抛错误、不触发accept；回复循环须按可靠HTTP证据记录response_observed，网络断连保留未知。05已报告401/429/500与断连四项官方runtime测试通过，最终集成仍待验。
- 110草案尚未成为正式迁移。严格结构门禁、109→110数据/UUID保持、原请求用途绑定及并发末次额度须一起验。
- `application/model_priority.py:412`一个background_call包住裁决；`memory_extraction/adjudication_adapters.py:77`及`:167`可发两次HTTP。许可不等于物理attempt，不能复用单attempt计数。
- 通用模型工厂默认重试2，生产工厂多数显式0。须核对实际SDK配置并逐HTTP派发分配attempt；避免外层持许可、内层再次acquire在并发1时自锁。
- 真正发送/响应接缝为 `memory_trace/transport.py:130`和`:160`，异常结算须包底层handle_request；`:225`无trace调用不能漏。
- `tasks/worker.py:718`已有任务ID，但TraceSession还需显式调用身份；`application/skill_learning.py:109`的scope/task须传到`skills/learning_runtime.py:67`。不得跨线程猜thread-local归属。
- `memory_trace/context.py:99`的CallObservation需绑定permit/attempt；`:258`及`:409`携原call_id关联旧ledger UUID，不能事后用last_call_identity补猜。
- 升级 `application/memory_upgrade.py:60`按operation扣一次，裁决二次发送会漏扣；须关联 `persistence/memory_upgrade.py:281`原job累计预算，逐物理请求扣一次。
- 整理 `memory/organization_quality_transport.py:104`已逐HTTP预约 `persistence/layered_memory.py:585`；补attempt关联及异常结算，不得双扣。本人资料允许contact_id=None，与110当前非空约束冲突，落盘前明确用途/范围合同。
- 若Python前台仍可达，`application/model_permit_client.py:128`只有整轮许可，`reply/adapters/model_call_ledger.py:25`仅事后LangChain run_id；需显式跨异步传prepared.scope/request身份，或证明旧路由不可达。
- `persistence/background_tasks.py:1183`将过期任务变retryable，`:657`允许重领；须查询原任务未结算/unknown attempt，保留累计预算并阻止自动重放，不能用许可journal代替PG任务关联。
- 最小验收：裁决两次HTTP、非2xx、预约失败零发送、发送后断连、台账已提交但ACK丢失、过期unknown不重放；单来源删除保留最小记录，联系人/账户完整入口清除并拒绝晚写。

上述问题已交05负责人。共享host/command/schema由主协调在领域接口稳定后装配；不以直接执行scratch SQL、手删旧ledger或手调恢复函数替代真实入口验收。
