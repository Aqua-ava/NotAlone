# 固定版本与边界核对
- 版本：官方deepseek-ai/deepseek-harness，0.2.1-rc.2，SHA `687f282e8625c6b8d11ff58211a90524be2e4317`。
- 已读本机官方归档 package.json:3、docs/architecture.md:5–45、packages/core/agent/src/runtime-types.ts:175–202；归档来源与完整SHA证据沿用baseline/dsh-official-evidence.md:7。
- 同时直接查证[固定SHA官方架构](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md)。业务通过profile薄插件装配，插件卸载负责运行资源；不改DSH核心。
- cancel/whenIdle只证明框架生命周期接口，不能替代PG事务或删除抑制；继续保留19宿主invalidateAndDrain。
- 本票新增无正文业务身份事实，在现有contact→owner事务边界登记和消费，无模型、Tool或DSH新接口。Python仅补过渡历史/自动入口，最终TS替换目标不变，不提前重做17。
- 数据依据：privacy-deletion.md:130–146、domain-data消息来源模型、core-flows.md:349–368，ADR-023/025/030/089及102；本票对删除不复活合同作必要实现，不新增外部发送或恢复授权。
