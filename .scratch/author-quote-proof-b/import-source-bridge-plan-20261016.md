# 作者引句 B 的真实导入来源桥接计划

日期：2026-10-16。接续已批准的 ADR-046／047／060 与 [B 规格](spec.md)，只补已约定导入／loader seam 的来源生产验证，不扩候选语法或生产默认。

## 接缝与步骤

1. 在新随机 `_test` 库迁移当前 schema，仅准备合成 owner／contact 与其已确认渠道身份。合成 JSONL 必须经 `import_file`、`PostgresIngestRepository` 和真实解析／规范化形成消息与来源；不得手插或回填来源引用、载荷、摘要。
2. 用真实 `load_contact_messages` 取得来源快照。明确选择其中一条组成 B 规定的单消息窗口，经实际 grounded-v3 编译、一次 Fake V proof2、`ExtractionFlow`／producer、默认 `MemoryAdoption` 保存待确认候选，再核回读和候选 API。此显式选窗不宣称生产批次默认已切换或支持多消息。
3. 每次新增一个行为检查后运行最小测试。现有实现若直接通过，如实记作新覆盖，不伪称产品 red；用缺 proof、完整多消息上下文、来源首部空白与正式删除请求验证边界。来源停用后的 loader／当前依据状态及实际来源删除另走公开接口验证。
4. 只更新放行台账的当前能力描述，区分生产默认未知与显式 B 的有限路径；所有维度仍未放行。运行新测试及必要相邻回归，保存实际日志和自有库／文件清理收据，交双轴审查后由主 Agent 提交。

## 判定与边界

正控须证明导入器真实提供原资料摘要、引用定位和原载荷，producer 仅从当前完整来源生成版本3依据／版本2 basis；self／contact、刚／刚刚与句号保持实际作者和完整事件。负控不取得相同依据或自动采纳。所有保存结果默认 pending、auto=0。

使用 Conda `NotAlone`，显式 `PYTHONPATH=src`、`NOTALONE_DISABLE_DOTENV=1`；数据库仅 `/tmp` 管理连接与本测试新建随机库，结束后逐库检查 residual=0，临时合成文件清除。Fake V 是模型边界替身，不调用真实 HTTP。没有业务库、私人聊天、App、微信、发送、旧窗口 trusted 字段回填、质量门或逐类放行变更。若新测试暴露产品源码故障，先报告实际 red 与最小文件范围，由主 Agent 协调，不擅改其他模块。

## Answer

[实际结果](import-source-bridge-result-20261016.md)已完成，37项相关检查通过，8个不同自有随机库与临时文件清理复核通过，Standards／Spec最终各0项。既有产品直接通过本片新覆盖，没有产品红灯或源码修复；原03的广泛质量AC保持。
