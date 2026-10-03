# Hindsight 本机实验运行

本目录只包含本任务新建的合成资料。服务是实验装配，生产回复路径、业务配置、feature flag 和 Python 产品依赖均未修改。单次 smoke 证明接缝可用，不能证明 Recall@5 收益、P95 或正式接入可行。

## 固定环境

- 源码：`f7dd3f4fd7420f7beec60c32c965e5e5cf7be066`，`hindsight-api-slim 0.10.2`，按官方 `uv.lock` 安装。没有修改上游源码。
- API：`http://127.0.0.1:18888`，单进程，仅本机监听。
- 数据库：独立 pg0 `notalone-hindsight-f7dd3f4`，PostgreSQL 18.1，`127.0.0.1:18543/postgres`。使用合成实验默认身份 `postgres`，默认口令 `postgres`；没有业务凭据。
- runtime：`/tmp/notalone-hindsight-runtime-f7dd3f4`；venv、database、models、service.log、service.pid、manifest.json 均在此目录。
- embedding：`BAAI/bge-small-zh-v1.5`，SHA `7999e1d3359715c523056ef9478215996d62a620`；实际 512 维。空库启动时官方迁移自动把向量字段由 384 调整为 512，日志已核对。
- reranker：`cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`，SHA `1427fd652930e4ba29e8149678df786c240d8825`。
- 两个模型均用 CPU，`OMP_NUM_THREADS=2`，关闭 remote code，离线加载固定本地快照。公开下载只请求模型/依赖，没有上传记忆或 query。

运行配置显式设置 LLM provider `none`、chunks、关闭自动归纳、world-only recall，不调用 reflect、mental models 或手动归纳。启动环境不继承业务变量，设置 `PYTHON_DOTENV_DISABLED=1`，HTTP 客户端禁用代理和重定向；模型缓存使用独立路径且启用 `HF_HUB_OFFLINE=1`。API 启动日志已核对两个 local provider 和 `LLM=none`。

## 安装与运行

先准备已核验的上游源码 checkout；下例使用本轮已有的 `/tmp/hindsight-readonly.D5OLmZ`。脚本会拒绝其他 SHA。安装在独立 Python 3.11 venv，不在 Conda 产品环境安装 Hindsight。

```sh
source /Users/local-user/miniconda3/etc/profile.d/conda.sh
conda activate NotAlone
PYTHONPATH=src python -m notalone.experiments.hindsight_runtime prepare --source /tmp/hindsight-readonly.D5OLmZ
PYTHONPATH=src python -m notalone.experiments.hindsight_runtime start
curl --fail http://127.0.0.1:18888/health
PYTHONPATH=src python -m notalone.experiments.hindsight_smoke --output experiments/hindsight/smoke-result.json
```

`start` 返回时模型/迁移可能仍在加载，以 health 成功为准。`status` 查询独立 pg0；API 当前 PID 在 service.pid，健康情况用 health 查询。重启使用 stop 后 start，保留同一数据库与模型目录。

```sh
PYTHONPATH=src python -m notalone.experiments.hindsight_runtime stop
PYTHONPATH=src python -m notalone.experiments.hindsight_runtime start
```

每轮 smoke 随机生成 owner/contact，使用其稳定隔离键的哈希作为新 bank ID。先通过 API 核对 memory 总数与 mental model 总数为零，核对 resolved config，再写入三条合成已采纳关系记忆。document metadata 保存 local ID、owner、contact、layer 和 revision，所有最终依据由本地 store 回读。

smoke 使用临时 `tau_B=0.003`，仅验证低词面重合正例、无关候选过门与真实 Context 当前性校验。每次真实 recall 要有同次 `[4] Reranking [cross-encoder]` 候选数量和 `[RECALL ...] Complete` 日志；部分超时警告、缺分值或缺日志均记为失败。客户端只支持串行独占服务调用；其他调用并发写入日志时不能凭本机制验收。服务日志异常被拒绝，B 不改用 A 后冒充成功。

## 停止与清理

`stop` 只停止本实验 API 与独立 pg0，保留数据库/模型，便于生命周期和重启验证。完成整轮实验后，先停止服务，再通过 pg0 的独立实例 drop 清除本任务数据库；只清理 `notalone-hindsight-f7dd3f4` 与上述 runtime 目录。无需也不得操作业务数据库或其他 pg0 实例。公开模型缓存可以一并清除或保留，说明中应记录选择。

当前服务暂保留供任务 03/04 使用。smoke 原始结果在 [smoke-result.json](smoke-result.json)，包含合成 UUID 和 document 映射；版本证据在 [runtime-manifest.json](runtime-manifest.json)。这些资料可以提交；完整安装缓存、数据库与进程日志不提交。

## 验证和限制

已运行真实源码服务的 retain → recall → 本地复验 → Context.build → validate_current。现有词法 A 在本 smoke 正例为空，B 选入「对方乳糖不耐受」；单次耗时仅是 smoke 数字。尚未运行独立校准集或最终评测，不承诺泛化收益。本任务测试覆盖语义过门、低分拒绝、多 chunk 去重、旧 revision 拒绝与排序、同次 HTTP 诊断及云端/其他 bank 拒绝；超时用外部 HTTP 替身验证确定性拒绝，真实部分超时故障留待生命周期任务。

本机 Docker Desktop 已开启，但服务实际采用原生 venv + pg0，没有启动实验容器；Docker 状态不证明本服务以容器运行。磁盘持久化、备份残留及正式环境删除效果不在本次 smoke 证明范围内。
