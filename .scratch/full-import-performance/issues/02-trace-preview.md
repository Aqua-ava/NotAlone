# 02: 完整追踪写入与预览流水线

Triage: ready-for-agent
State: resolved

## What to build
交付真实完整追踪负载的写入优化和轻量预览；原始、规范化正文、捕获身份、顺序、回执和删除路径均完整。

- [x] 用真实追踪比较 VALUES/COPY 后选择实现并记录证据
- [x] 快照不可变，逐次规则摘要新鲜，失败整批回滚
- [x] 预览与提交边界保持，提交重新验证文件字节及联系人
- [x] 相关测试、验证命令和本地提交有记录

## Blocked by
None（两路独立，根负责人负责最终集成验证）

## Answer

### 实现与数据边界
真实处理记录改用 `COPY ... FROM STDIN` / `write_row` 逐条发送；只保留当前记录的编码，不积累整批 JSON 或 VALUES 占位参数副本。所有墓碑检查仍先于 batch/record 写入，COPY 仍属于调用方业务事务，并核对实际写入行数。原始文本、parsed/converted、捕获 UUID、position、消息/来源引用回执及删除路径保持；字段内容未删除或缩减。

快照与持久化使用紧凑 UTF-8 JSON。ProcessingRecord 保留三参数构造、payload_json、每次返回独立字典的 payload()/with_fields()，未新增正文缓存。预览采用同一个 reader 的不捕获逐条追踪分支；完整提交仍重新读取文件字节、计算 SHA 并验证范围。逐次规则文件读取未改变。

### 真实负载写入选择证据
PostgreSQL 16.14、psycopg 3.3.4；10000 条与统一基准相同的合成中文消息，经实际 reader/normalizer 构造完整原始/parsed/converted 追踪，再补实际形状的 receipt。1 次预热，5 次交错顺序保留样本；仅测写入+提交（不代表完整导入）。原编码 JSON 29,121,808 bytes，紧凑 UTF-8 27,051,808 bytes（-7.1%，不据此宣称 JSONB 存储体积同比下降）。

| 路径 | 中位秒 | 保留的 5 个秒样本 |
| --- | ---: | --- |
| VALUES 原编码 | 1.037124 | 1.367537, 1.025482, 1.163130, 1.037124, 1.026729 |
| COPY 原编码 | 0.978288 | 0.978288, 0.789374, 1.449450, 1.006757, 0.747451 |
| VALUES 紧凑 UTF-8 | 1.166384 | 1.166384, 1.091683, 1.111768, 1.275051, 1.248196 |
| COPY 紧凑 UTF-8 | 0.913947 | 0.815157, 1.135218, 0.913947, 1.411397, 0.810859 |

按同编码比较 COPY 中位低 21.6%；本机样本有噪声，采用 COPY 的最终效果由根负责人独占窗口下的完整 import_file 交错基准确认。随机自有 `_test` 库应用正式迁移，完成后精确核验已删除。接口约定经 [Psycopg 官方 COPY 文档](https://www.psycopg.org/psycopg3/docs/basic/copy.html) 与本机运行确认。

### 验证
- Red：`test_read_without_processing_preserves_bytes_digest_and_records` 先因 reader 不支持新可选参数失败；最小实现后通过。
- `PYTHONPATH=src:. NOTALONE_DISABLE_DOTENV=1 PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/unit/ingest -t . -v`：49 项通过。包括不可变嵌套快照、兼容构造、Unicode/CRLF 原始字节、规则文件变化及预览后同大小/同 mtime 文件修改被提交拒绝。
- 相同环境使用自有随机库运行 `tests.integration.ingest.test_source_processing_trace tests.integration.ingest.test_import_command`：48 项通过。包括 1000 行顺序与回执、超大行及 Unicode/转义字符、后续记录故障原子回滚、4097 条后的墓碑整批拒绝、重复导入、删除/撤销竞态和联系人隔离；库精确清理通过。
- `git diff --check` 通过。按约定合并 integration 最新基准提交；根负责人负责最终双轴审查、跨路验证与真实 dev App 验收。

剩余限制：COPY 改变协议消息形状，计数器必须覆盖 Cursor.copy/write_row；已向根负责人交接并完成计数器支持。64 MiB 文件仍是完整读取/校验后原子写入，本轮未改为全流式导入。
