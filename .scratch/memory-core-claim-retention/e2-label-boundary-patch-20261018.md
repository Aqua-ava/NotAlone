# E2 标签边界提示后继修复

2026-10-18，指代会话在独立官方合成场次的 Agent 审阅中发现：A04 事项未知未在 alternatives 保留、A07 仅有家里来访就标 family、A14 仅推进消息交换的发地址意向被保存、A15 纯谢语另提为 event 并进入模拟 auto。该会话报告已安全停止并闭账，A16 未运行；本会话只读核对四份封存结果，不重试原场、不重签该场审核，不把通用 matcher 的 passed 当作语义通过。

本补丁应指代会话的用户授权接口请求，接续已冻结的 `d159417d` 编译修复，作为未来请求的新版本；不修改已冻结场次。仅在 `GROUNDED_V2_PROMPT` 追加四条通则：

1. unresolved 检查理解主张所需的事项、对象及角色，不限人物身份；已知部分和原类型保留。
2. family 需要亲属或家庭关系证据，单纯地点或来访不足；无更具体证据时用 other。
3. 仅推进当前消息交换、没有独立事实、明确承诺、关系约束或其他安排的一次性传递可省略为 not_memory。有信息的地址或文件内容、真实计划和承诺继续保留。
4. 不含独立事实的礼貌谢语用 greeting；有信息的同句或相邻句分别保留，不因谢语删除整条消息。

没有案例名、整句匹配或硬编码事实；未增加类型、模型阶段、服务、采纳许可或代码后处理。原基底、显式 v3/v4 提示和全部动态 schema 字节不变。E2 新提示 SHA256 为 `283e7e75239067bec8c98615336ca9af46f9cef6d2cc180342567aa42a7d82e5`，原摘要 `c1ae0bb…` 保留在提交历史及旧冻结场；测试只更新当前 E2 摘要，不追改模型参考答案。

使用仓库指定 Python，在 `backend/` 以 `PYTHONPATH=src` 执行：

```sh
python -m unittest tests.unit.memory_extraction.test_e2_stable_fact_guidance tests.unit.memory_extraction.test_core_semantics_contract tests.unit.memory_extraction.test_grounded_v3_runtime tests.unit.memory_extraction.test_grounded_v4_runtime -v
```

首个新 SDK 提示合同测试在两种 E2 入口均红，追加提示后转绿。扩展组最初仅两个旧 E2 摘要断言失败；更新当前摘要后 42 项通过。保护控制含独立完成事实、礼貌省略、一次性消息传递、真实承诺、关系约束和来访计划，均为给定标签，不能证明模型已经学会分类。固定字节测试同时确认 v3/v4/schema 未变。

Standards 与 Spec 均无阻塞；Spec 提出不含“保证”的交付义务边界，已补给定 plan 标签的正例控制，但其真实模型泛化仍未认证。两轴采用独立 Agent 审查，`reviewer_kind=agent`，不等待人工。真实模型效果由指代会话另建独立预算、保持 E/V 相同配置的新场验证；本补丁提交与 SDK 通过不代表质量门通过。原票仍 claimed，生产放行表空，私有六窗/四留出未覆盖。本会话无新模型调用、真实联系人处理、业务数据写入、桌面操作或远端 Git。
