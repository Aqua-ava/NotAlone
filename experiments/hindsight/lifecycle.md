# Hindsight 生命周期与拒绝验证

日期：2026-10-04。任务 03 已完成；这份结果只验证合成资料的生命周期，不评价中文召回收益。原始证据见 [lifecycle-result.json](lifecycle-result.json)，服务与模型版本沿用 [runtime.md](runtime.md) 和 [runtime-manifest.json](runtime-manifest.json)。

## 本地拒绝与外部清除

真实服务最终复跑通过 27 个检查点。每轮生成三个随机 bank，分别属于当前范围、同用户另一联系人、另一用户同联系人；只操作本轮明确 allowlist，所有 retain 同步串行完成，删除前核对没有未终结的 retain operation。

| 行为 | 实际证据 |
| --- | --- |
| 删除前可用 | 原始 recall 与真实 Context 都能选入有效正例；向量列存在且为 512 维。其他两个范围使用相同正文和 document ID，也能独立召回。 |
| 多来源仍支持 | 两个来源移除一个后，正文保持，当前来源和 revision 更新；全部存活 unit 的 metadata 刷新，Context 的正文与来源来自本地权威快照。此轮 metadata-only 更新保留了 unit ID。 |
| 正文 delta | 同 document 的新正文和 revision 可回读，旧改变内容不再位于当前 unit；更新重试未增加副本。不要求所有未变 chunk 的外部 ID 被替换。 |
| 最后来源删除 | DELETE 完成；重复删除明确记录 404。document 与 chunks API 为 404；documents、chunks、memory_units（含 embedding）和 invalidated_memory_units 均为 0 行，已保存旧 unit ID 也不存在。 |
| 运行缓存和重启 | 同实例重复原查询不再包含已删本地 ID；相同持久库停止并重启后仍不可检索，控制正例仍在。 |
| 单条与修正 | 实际本地 delete 后，即使外部副本尚存也不进入 Context；实际 correct 生成新 UUID、旧 ID 失效，随后清旧 document 并索引新 ID。删除后重建及重建重试保持一个当前副本。 |
| 联系人 bank 清除 | bank export API 返回 404；banks、documents、chunks、memory_units、archive、entities、observation_history、mental_models、attachments、async_operations 按该 bank 均为 0，三个作用域 HNSW 索引消失。其他 owner/contact 的控制样本仍可召回。 |

两个外范围控制 bank 最后也只按本轮 allowlist 清理。实验 API 和独立 pg0 保留运行，供任务 04 使用；模型、数据库目录与正式配置不变。初始发现旧 service.pid 对应进程已退出，启动日志没有可归因的退出原因；先按固定配置恢复并确认 health，再执行以上验证。

## 接缝与故障

13 个新增测试与现有 10 个实验测试、28 个 Context 测试共 51 项通过。测试通过已有 RetrievalPort 装配真实 Context 并执行 validate_current：

- 错误 bank、跨 owner/contact、缺失映射、旧 revision 拒绝，同时保留有效正例；相同正文不同本地 ID 分别计入，多 chunk 去重。
- 回读完成后与上下文选入后分别提交 delete/correct，当前性复验拒绝旧快照；来源/revision 与过期变化也拒绝旧快照。有效期组保留可用正例。
- 本人资料继续按 owner 本地检索；联系人 5 条/600 字符与本人 3 条/240 字符独立。未授权关系背景的普通改写和 ID 权威复验不调用外部服务。
- 服务不可用、超时、分数缺失与重排未完成均保留 failure，Context 空降级不冒充 B 的成功；HTTP 外部替身证明部分重排日志会拒绝，即使响应仍有分数。
- 空结果也要求本次完成日志；此前旧日志不足以把空响应判为成功。此缺口已以失败测试定位并修复，真实空 bank 也通过同次完成性核验。
- runtime 停止前核对 PID argv 归属，等待 API 实际退出后才停数据库；其他进程 PID 被拒绝。

确定性故障与竞态只替换外部 HTTP 或数据库权威状态边界，不用它们代替真实服务生命周期证据。多来源来源/revision 更新使用 `SyntheticMemoryStore` 明确声明的合成快照；它不证明业务来源删除任务已接入 Hindsight。普通 correct/delete 使用现有内存公开方法，未虚构同 ID 正文修正。

## 本次成本观测

以下来自最终少量夹具复跑，保留原始单次测量；不是大集性能、P95 或完整首次安装成本。

| 操作 | 实测 |
| --- | ---: |
| 单文档初次同步 retain（四次） | 20.47–39.66 ms |
| 相同 retain 重试 | 6.82 ms |
| metadata-only 来源/revision 更新 | 6.83 ms |
| 正文更新 | 27.33 ms |
| 更新重试 | 6.27 ms |
| 删除后重建 | 23.51 ms |
| 停止、重启至 health（模型缓存已在本机） | 9,981.34 ms |
| 运行后 API 单点 CPU/RSS | 16.0% / 960,320 KiB |
| 独立数据库目录 / 模型目录占用 | 59,868 / 591,612 KiB |

RSS 与 CPU 是运行后单点观测，不能称为峰值。数据库目录包含实验运行和日志等持久文件；SQL 清除不会把目录恢复至初始大小。首次下载与无缓存冷启动未在任务 03 重新测量。

## 命令与证据范围

所有产品 Python 命令先激活 Conda `NotAlone`，显式 `PYTHONPATH=src`。本轮没有安装 Hindsight 到产品环境；格式工具固定 black 24.10.0 安装在独立 `/tmp/notalone-hindsight-black`。

```sh
source /Users/local-user/miniconda3/etc/profile.d/conda.sh
conda activate NotAlone
PYTHONPATH=src python -m notalone.experiments.hindsight_lifecycle --output experiments/hindsight/lifecycle-result.json
PYTHONPATH=src python -m unittest tests.unit.experiments.test_hindsight_lifecycle tests.unit.experiments.test_hindsight_adapter tests.unit.experiments.test_hindsight_client tests.unit.reply.test_context_retrieval
PYTHONPATH=src python -m mypy --follow-imports=silent src/notalone/experiments/hindsight_client.py src/notalone/experiments/hindsight_adapter.py src/notalone/experiments/hindsight_lifecycle.py src/notalone/experiments/hindsight_lifecycle_db.py src/notalone/experiments/hindsight_runtime.py
git diff --check
```

Context7 当前无可用工具，SQL 参数绑定、连接参数与安全标识符组合改查 [Psycopg 官方连接文档](https://www.psycopg.org/psycopg3/docs/api/connections.html) 和 [SQL 组合文档](https://www.psycopg.org/psycopg3/docs/api/sql.html)，再与实际 psycopg 3.3.4 核对。HTTP 接口使用锁定 Hindsight 源码的 documents、retain 和 bank delete 契约，运行时额外核对 public schema、Alembic 版本和实际 CASCADE 外键。

开发阶段一次真实空 bank 验证因 runner 将 tuple 与 list 比较而误报失败，已修正为判断集合为空；该失败检查与其 allowlist 留在 JSON 的 `development_runs`，并按原 allowlist 清理。它不是服务故障，不从正式质量或耗时组抽走样本。

本结果证明活动 SQL 行、向量列、作用域索引和服务可检索副本按声明清除；不证明 PostgreSQL MVCC、WAL、死索引元组、备份、进程暂存或介质块的物理擦除。未触及业务库、真实聊天、其他 bank、生产开关或自动发送。正式中文收益、无关注入与 P95 仍须任务 04 的冻结对照实验验证。
