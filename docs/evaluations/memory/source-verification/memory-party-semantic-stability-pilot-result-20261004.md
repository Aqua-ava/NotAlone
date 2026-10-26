# 直接参与者核验语义稳定性有限对照结果（2026-10-04）

本轮按已批准的[语义稳定性有限对照提案](memory-party-semantic-stability-pilot-proposal-20261004.md)完成一笔新的独立匿名试验：只用现有ECNU `ecnu-max`，阶段1和阶段2各4次，共8次公开V调用；不读真实聊天、actual/held留出，不使用DeepSeek官方key或端点，不写业务记忆、水位或产品默认。

联网前预检全部通过：本机3项结构测试、mypy、AST、提示单叶差异、真实SDK具名工具绑定（合成key、无网络）和入口dry-run均通过。候选提示相对于上一版只增加“来源支持与`described_party`独立判断，`report/reported`本身不是`uncertain`理由”的单叶文本，工具schema、输入、Flow、窄guard和采纳门保持不变。

阶段1先审raw再审full，4个位置全部完成。候选两次均返回`described_party=mixed`，目标证据均定位到原话，`verdict=supported`且`issues=[]`；编译后的Fact保留全部原14字段、风险标记为空，因`report/reported`保持`pending`。同期基线两次均返回`described_party=contact`，复现旧人物方向错误。阶段1门通过后才开放阶段2。

阶段2的4个位置也全部返回并通过同一审计：候选再次达到`mixed 2/2`、`supported 2/2`、完整Fact无新增语义风险2/2、`pending 2/2`；合并两阶段为候选`mixed 4/4`、目标证据4/4、完整Fact无新增`semantic:*`风险4/4、坏自动采纳0。基线4次仍为`contact`，因此旧错误在同期控制中持续存在。

阶段2运行器在四个调用完成后，收尾等待审计时触发了预算类的累计slot检查并报告`BudgetRejected`。四个阶段2位置的raw、compiled、Flow和台账均已完整保存；这次编排停止收据被保留，没有重试、补位或第9次调用。最终预算已按8/8闭账，禁止重开。

结果支持这处提示单叶在这组匿名C4窗口中同时改善人物集合判断和语义风险稳定性，但不等于整体记忆准确率已经修复，也不授权把提示改入产品默认。若要修改产品提示或进入真实同批／留出验证，需另按领域文档和发布范围重新决定。

原始材料、raw/full审计、阶段门、停止与闭账收据保存在仓库外私有目录`~/.notalone/audits/memory-party-semantic-stability-pilot-20261004/`（目录0700，文件0600）。关键收据：预检`preflight-v1.json` SHA `affe00e846e46cb17a406fdffa92899d5eda4ea42a56d31b85ada61f3ec91c4e`；阶段1 raw SHA `940f04ee1c85a8dd7ce70e8973ddfbdbb97e3bd5d8d443b2eb2de4b1c639f625`；阶段2 raw SHA `a33b5d9fce0e30a5cd1a2ea5cf8852d31853ffc8c4f7cc72c291631bd2cb2edb`；最终full审计 SHA `d080532e2593c014131b52ef7f3182a95d8c8fea77dcf64bb1e16c6698024d9c`；闭账 SHA `7d8b3c85626c4616b4019c38e6e601f82fb2f7af0f31a5b32f587837169581a1`。
