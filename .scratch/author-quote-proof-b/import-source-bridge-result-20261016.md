# 作者引句 B：真实导入来源桥接结果

日期：2026-10-16。按[桥接计划](import-source-bridge-plan-20261016.md)完成新增集成验证与台账能力描述更新，独立双轴审查完成。没有产品源码变更，不完成原03的广泛 AC，不新增质量或放行资格。

## 实际覆盖

新增 `backend/tests/integration/ingest/test_author_quote_source_bridge.py`，全部来源字段经合成 JSONL → `import_file` → `PostgresIngestRepository` → 实际解析／规范化／来源存储 → `load_contact_messages` 产生，没有手插或回填 `source_document`、规范消息或 `message_source_ref`。

正控独立比对导入文件字节摘要、原载荷、`jsonl:1/2` 定位、来源 ID 和实际处理记录。导入文件含已确认同一联系人范围内的两条作者消息；明确分别选择一条进入 B 的单消息窗口，经 grounded-v3 compiler → 一次 Fake V proof2 → `ExtractionFlow`／producer → 默认 `MemoryAdoption` → PostgreSQL 待确认保存／重核回读及候选 API。联系人“刚”与用户“刚刚＋句号”均生成当前版本3依据／版本2 basis，有限能力及独立 truth_intent／纯文字表示可读取；默认空放行表保持，每次 pending=1、auto=0。此显式选窗不是生产批次默认行为。

负控使用实际导入结果：缺 proof 时不自签；完整两消息窗口不被悄悄缩成单消息，basis 保持 null；来源首部空白被导入器原样保留，compiler 输出仍含该空白且 basis 未知，不改候选取得正例。正式 `PostgresSourceTasks.request_delete` 立即使 loader 停读该来源，原候选与 API 的当前依据状态变为 false，存储默认 AUTO 确认分支拒绝；经实际 `delete_source/verify_deleted` 后候选、候选 API 和 loader 结果清空。本片未据该分支宣称人工确认 API 已覆盖。

## 实际验证与清理

每片新增测试后运行最小检查；既有产品实现全部直接通过，没有暴露需改源码的故障。因此本轮没有产品 red，不把新测试的直接 green 或负控拒绝伪记成产品红→绿。

| 执行 | 结果 | 自有随机库 |
| --- | --- | --- |
| 导入正控首跑 | 1 方法通过，含2个作者 subcase；0.693秒 | 1库清理、residual=0 |
| 缺 proof／整窗上下文及来源空白 | 2 方法通过；0.768秒 | 2库分别清理、residual=0 |
| 正式删除请求／来源删除 | 1 方法通过；0.424秒 | 1库清理、residual=0 |
| 最终新集成＋相邻 producer／维度门 | 37／37通过；2.010秒，其中新集成4、producer8、维度门25 | 本次4个新库分别清理、residual=0 |
| 独立精确名称清理复核 | 首跑与最终共8个不同自有库，8份清理收据，管理连接复核 exact_name_residual=0 | 不查询或清理其他业务库 |

各运行分别计数，不把重复执行当作新增独立测试。8次临时文件目录均有清理后不存在的断言及收据。没有遗留测试进程或自有库。

Standards初审0项；Spec初审发现把存储默认AUTO确认分支误称人工确认，结果已收窄并明确未覆盖MANUAL API，最终两轴各0项。测试和产品源码未因该措辞修订而重跑或改变。

所有 Python 命令先 source Conda 初始化脚本并激活 `NotAlone`，在 `backend/` 执行；`PYTHONPATH` 明确指向本工作区 `backend/src`，`NOTALONE_DISABLE_DOTENV=1`，追踪关闭。最终核心验证命令：

```sh
python -m unittest tests.integration.ingest.test_author_quote_source_bridge tests.unit.memory_extraction.test_author_quote_producer tests.unit.memory_extraction.test_dimensions -v
```

本机忽略日志位于 `desktop/artifacts/author-quote-source-bridge-20261016/`：`01-import-positive.log`、`02-import-boundaries.log`、`03-source-deletion.log`、`04-final-related.log`、`05-cleanup-verification.log`。最终测试同时阻止同步／异步 HTTPX 出站；真实模型请求为0，候选 API 为进程内调用。数据库连接仅 `/tmp` 的管理连接和本测试实际新建的随机 `_test` 库。

## 数据影响与保留边界

只有合成文件、合成联系人和新隔离库；没有读取 `.env`、私人聊天或业务库，没有业务迁移、App／微信操作、发送或远端 Git 操作。旧候选和旧评测窗口不回填 trusted 元数据；生产默认 grounded-v2／legacy-v4、默认空放行表、原三门及维度 AND 均未修改。台账仅区分生产默认未知和显式 B 有限路径，所有维度仍未放行。

本轮只证明导入适配器真实来源字段能在显式有限 producer 路径中复核，不证明真实模型稳定生成 proof、现实到家、通用指代／转述、跨消息／省略／多第三方、媒体内容、原核心整体或每类至少15例质量；正式质量与用户逐类批准仍分别需要完成。
