# 02：后台召回单批预计算复用
Triage: ready-for-agent
State: resolved

## What to build
减少同批候选反复分词、统计和范数计算，保持公开召回与逐条采纳的数值、顺序和来源合同；交付前后对照数据。

## Blocked by
None (can start immediately)。

## Acceptance criteria
- [x] 保持公开函数签名及算术/RRF/决胜规则；只在单次调用预计算语料统计和记忆向量范数。
- [x] 固定 20×1000 负载 tokenize/sqrt 各 20020→1020，embedding 输入仍为 1020；不改 adoption 动态池，不增加跨批缓存。
- [x] 固定结果、数值、排序、错误、空输入、不同 top-k 等公开接口回归与既有来源/纠错/隔离链路通过。
- [x] 原始基线与实现相同输入报告独立计数、重复计时和内存，若模型预置补真实本地编码，不能只给假向量整体加速比。

## Comments
用户已授权实施。独占 recall.py 与对应新增合成测试/本任务单；必要跨范围先报告。不得修改持久化、adoption、协调 main 或原工作区。最终追加 Answer、真实命令/数据影响/风险，验证后本地提交并标记 resolved，不 push。

## Answer

实现提交 `31022834b62009633fa1abc68851eba1cdc482a0`：私有语料对象只在一次调用内保留文档词频、长度因子、文档频率及惰性 IDF，记忆向量范数各算一次。公开签名、query set 遍历和浮点累加顺序、余弦/RRF/top-k/ID 决胜保持；独立 `bm25_scores` 仍重建当时语料。未改 adoption、模型锁、提示词或存储，也没有跨批缓存和完整 Q×N 矩阵。

### 验证与审查

- TDD：词法与范数两个切片先各自出现 `8 != 5` 红灯，再分别实现至绿灯；日志 `/tmp/notalone-recall-red-lexical.log`、`/tmp/notalone-recall-red-norms.log`。
- 新增公开接口回归 12 项；连同 adoption、ALL 来源和合并模块共 61 项通过。覆盖数值、同分、零/负余弦、重复正文、不同 top-k（含既有负切片行为）、错误、空输入及下一调用重建。
- L1 HTTP 跨类别更新单例先通过，再运行该模块 17 项全部通过；覆盖更新、合并、部分非法裁决、人工纠错、owner 隔离及必需父来源删除。只替换外部模型，使用随机自有测试库；两个测试库均按精确名称核验已删除。
- 两轴只读审查：Standards 0 项，Spec 0 项；追加基准 CLI/编码计时也经 Spec 复核。
- `git diff --check` 通过。公开历史检查仍有既有 26 处本机路径命中，退出 1；未涉及本任务新增文件，不宣称公开检查通过。

实际命令使用工程规定的 NotAlone Python 解释器；以下省略其本机绝对路径。后端命令在 `backend/`，均设置 `PYTHONPATH=src:. NOTALONE_DISABLE_DOTENV=1 PYTHONDONTWRITEBYTECODE=1`：

```sh
python -m unittest tests.unit.memory_extraction.test_recall -v
python -m unittest tests.unit.memory_extraction.test_recall tests.unit.memory_extraction.test_adoption tests.unit.memory_extraction.test_all_source_adoption tests.unit.memory_extraction.test_merge -v
python /tmp/notalone-recall-http-validation.py single
python /tmp/notalone-recall-http-validation.py module
```

HTTP 临时运行器只装载现有 `TencentL1HttpTest`，额外保存自有库归属并在夹具清理后查询该精确库名是否仍存在。单例和模块日志分别为 `/tmp/notalone-recall-http-single.log`、`/tmp/notalone-recall-http-module.log`；单元日志为 `/tmp/notalone-recall-public.log`、`/tmp/notalone-recall-related-unit.log`。

### 相同负载的本机观测

原始基线固定 `746bb40b7a0a90105c39f76d2786c451a55c93f7`；实现源 SHA256 为 `a07c34c17b60c2f67a5d6ea45f8f1940bd423633c6a42f833fa0bb1cbb2c00ef`。环境为 Python 3.12.13、macOS 15.7.5 ARM64、`PYTHONHASHSEED=0`。输入、顺序和 ID 由脚本确定；每份 JSON 保存输入/源码/脚本摘要和全部样本。

独立计数：20×1000 的 tokenize 与 sqrt 均为 **20020→1020**，embedding 输入为 **1020→1020**。原始记录 `/tmp/notalone-recall-count-final.json`。

固定 16 维合成向量，20 条 query，各版预热一次，21 轮交替旧/新顺序。计时不启用 tracemalloc；表内单位 ms，P95 使用 nearest-rank（21 个样本的第 20 个）：

| 池条数 | 旧中位数 | 新中位数 | 旧 P95 | 新 P95 |
| --- | ---: | ---: | ---: | ---: |
| 100 | 40.911 | 8.254 | 50.325 | 9.773 |
| 1000 | 420.194 | 80.965 | 558.347 | 109.521 |
| 10000 | 4344.949 | 855.836 | 5397.430 | 974.478 |

三档均逐 query 比较精确 BM25 分数及有序候选 ID，相等。原始样本及 min/max 在 `/tmp/notalone-recall-timing.json`；这是固定向量评分观测，不代表包含真实编码的整体收益。

真实本地模型使用预置 `BAAI/bge-small-zh-v1.5`，固定快照 `46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59`、fastembed 0.9.0、512 维，七个资产均存在；`local_files_only` 及离线环境保持，未下载或外发。20×1000、预热后 21 轮交替测量：

| 指标（ms） | 旧中位数 | 新中位数 | 旧 P95 | 新 P95 |
| --- | ---: | ---: | ---: | ---: |
| 完整混合召回 | 5379.210 | 4767.190 | 5771.971 | 5620.899 |
| 其中实际编码 | 4392.286 | 4322.762 | 4652.511 | 5128.755 |

完整召回的观测中位数减少 11.38%，但旧版范围 4490.905–5903.863 ms 与新版 4022.218–5633.227 ms 重叠；这是本机合成输入观测，不承诺通用提速倍数。编码量每次仍为 1020，编码时间波动不归为本次收益。每模块首次加载加完整召回分别为 5484.511/4453.350 ms，按旧→新顺序记录，未清 OS 文件缓存，不与稳定态合并。原始数据 `/tmp/notalone-recall-local.json`。

独立 tracemalloc 单次峰值字节如下，排除预建向量输入、原生模型和 RSS；原始数据 `/tmp/notalone-recall-memory.json`：

| 池条数 | 旧 Python 峰值 | 新 Python 峰值 |
| --- | ---: | ---: |
| 100 | 157549 | 174174 |
| 1000 | 1546096 | 1729638 |
| 10000 | 14204597 | 17277307 |

复用语料会使统计与排序临时数据同时存活，因此峰值增加；它们只在本次调用内保留。未将这些数字描述为全进程内存或真实模型内存。

### 复现与数据影响

仓库根目录运行 `scripts/benchmark_memory_recall.py`，同样使用工程规定解释器及 `PYTHONHASHSEED=0 PYTHONPATH=backend/src:backend NOTALONE_DISABLE_DOTENV=1 PYTHONDONTWRITEBYTECODE=1`：

```sh
python scripts/benchmark_memory_recall.py --baseline-ref 746bb40b --mode count --sizes 1000 --output /tmp/notalone-recall-count-final.json
python scripts/benchmark_memory_recall.py --baseline-ref 746bb40b --mode timing --sizes 100 1000 10000 --samples 21 --output /tmp/notalone-recall-timing.json
python scripts/benchmark_memory_recall.py --baseline-ref 746bb40b --mode memory --sizes 100 1000 10000 --output /tmp/notalone-recall-memory.json
python scripts/benchmark_memory_recall.py --baseline-ref 746bb40b --mode local --sizes 1000 --samples 21 --output /tmp/notalone-recall-local.json
```

首次固定向量计时使用脚本默认的同一完整基线 SHA；后续增加显式 `--baseline-ref` 和真实编码分段记录，不改变评分实现。模型缺失时沿原失败合同报告，不由脚本下载。

只处理合成文本。测试库已清理，无新增模型资产或业务迁移；基准进程已结束并释放计时窗口，日志/合成 JSON 和临时 HTTP 运行器保留 `/tmp` 供主会话复核。不读取业务 `.env`、聊天或业务库，不启动 App/微信，不打包、push 或创建 PR。未运行全量测试或桌面验收；组合验证与实际桌面由主会话负责。
