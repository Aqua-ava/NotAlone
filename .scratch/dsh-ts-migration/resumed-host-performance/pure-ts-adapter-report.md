# 纯 TS 性能采样准备更新

结论：已接入完整 TS 产品宿主；本次仅更新单个既有公开 HTTP／宿主用例并做短自检，1/1 通过。旧臂为固定 `3c168296e9e8edaa43b8b323ff693e790e709069`；新臂冻结为 `4f89bb976dd4086a02b7ae983fee2760d6e4ff64`。新臂后台树仅观察到 Node，没有 Python，`legacyPid` 缺席；**正式 40 轮／60 秒采样没有启动，原性能门槛仍未定。**

## 实际改动

- `host_fixture.py`：旧臂从固定旧提交归档 Python 源码、旧 SQL、项目配置及当时的生产 requirements／wheel 锁；新臂只归档同一已提交 HEAD 的 Node 业务代码、profile、锁文件及 SQL，完全不复制新树 `backend/src`。
- `legacy_runtime.py`：为旧臂建立独立 venv，禁用 system-site-packages；仅安装旧提交生产锁指定的 62 个 wheel。固定 URL 来自归档目录，逐个核验归档 SHA-256，再通过 `--no-index --no-deps --require-hashes` 安装并复核版本。安装器不会升级或修改共享 Conda 包；bootstrap Python 3.12 只提供解释器与 venv 工具，解释器摘要单列。此环境仅承担旧臂，不进入新臂产品树。
- 新合成库经产品 `schema-prepare-cli.ts --prepare` 和显式合成 DSN 准备，不再从新树导入 Python 迁移器。两臂每次继续恢复同一 dump，数据与工作负载不变。
- 新臂明确设置 `NOTALONE_HOST_RUNTIME=typescript`、`NOTALONE_REPLY_RUNTIME=typescript`、`NOTALONE_EXTRACTION_RUNTIME=typescript`、`NOTALONE_HISTORY_RUNTIME=typescript`，环境及配置文件一致，纳入冻结摘要和前后复核。旧臂不携带这些开关。
- `new-host.mjs` 继续复用产品 `launchDsh`，不再传 `pythonExecutable`；新臂 PATH 仅为选定 Node 所在目录与系统工具目录，没有 Conda 路径。产品、官方 profile、App 和桌面开发实例均未改动或重启。
- `host_perf.py`：记录 hostRuntime／legacyPid，并核验旧臂隔离依赖目录和职责配置摘要。整个后台进程树 RSS、父观察器另列、原样本数、门槛、seed 102／10,000 次 bootstrap 均保留；`host_statistics.py` 原“新臂含 Python 不认证最终 TS”保护字节未改。
- `test_actual_hosts.py`：在同一既有 CLI／HTTP／宿主边界校验隔离旧环境、新树不含 Python、四项职责、`hostRuntime=typescript`、无 legacyPid、整树无 Python、持久提交与 HTTP 读回、模型台账为零和清理。没有扩大到真实记忆或 App 验收。

## 本次验证证据

- RED：原准备器缺少隔离旧 runtime，更新用例先因 `old_runtime` 缺失失败，见 `pure-ts-red.log`。
- 首轮接通 Node 准备时，禁 dotenv 环境未显式提供 DB URL，准备失败；现已改为直接传合成 DSN，未放宽产品配置规则。该轮原始诊断保留仓库外，没有重构成成功观测。
- GREEN：只运行 `python -m unittest discover -s .scratch/dsh-ts-migration/resumed-host-performance -p test_actual_hosts.py -v`，1/1 通过；AST 与修改后的 Node 入口语法检查通过。没有复跑原四项统计／合成用例，也没有项目全量测试。
- 旧／新各一次业务 ready 启动、各两次 RSS 观察；三个 case 每臂预热一次、计分观察两次，共 18 次 HTTP 成功（6 次预热、12 次计分观察）。不是原协议要求的 20×60 秒和每例 10+30。
- 新臂 OS 后台树为 `node`，旧臂为真实 `python`；新臂公开 runtime 状态为 typescript 且无 legacyPid。两臂模型请求、模型台账、未知外网尝试均为零；自有进程及测试库已清理。
- 源码、Node 依赖、旧隔离依赖、解释器、快照、工具、职责配置前后复核全部一致；具体摘要与资格结果见 `pure-ts-validation.json`、`pure-ts-probe-report.json`、`pure-ts-green.log`。

## 可执行准备命令

从仓库根执行；仅用于根后续安排，以下示例不会自动启动正式长采样。`prepare` 冻结调用时已提交 HEAD，不混入并行工作区未提交改动。旧依赖可从已验证本地 wheelhouse 复用，但每个文件仍按旧归档锁核验；未提供缓存时只下载锁内固定公共制品。原始日志、venv、wheelhouse、配置、dump 与源码副本均保留在仓库外。

```sh
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/miniconda3/envs/NotAlone/bin:$PATH"
TASK_PERF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/notalone-host-performance-XXXXXX")"
python .scratch/dsh-ts-migration/resumed-host-performance/host_perf.py prepare --state "$TASK_PERF_DIR/state"
python .scratch/dsh-ts-migration/resumed-host-performance/host_perf.py collect --plan "$TASK_PERF_DIR/state/plan.json" --out "$TASK_PERF_DIR/probe" --probe
```

已有旧锁 wheel 缓存时，可在 prepare 命令追加 `--old-wheel-cache "$TASK_OLD_WHEEL_CACHE"`；不能用当前开发树 pyproject 或共享 site-packages 替代旧归档锁。正式长采样仍须等根完成真实覆盖与后续补丁收敛、冻结最终提交并停止并行负载，再依原协议启动 `collect --formal`，Electron 另列规则不变。

## 历史与边界

`validation.json`、`probe-report.json`、`green-final.log`、`report.md` 是原 5/5 与 `8221a619` 混合新臂历史证据；本次未覆写，不能把它们解释为纯 TS 成功。`final-ts-readiness*.md` 保留当时只读判断，相关运行脱钩已由根后续候选实现承接。当前纯 TS 短测也不能替代真实记忆覆盖、最终质量或正式性能签收。

只处理合成资料、固定归档源码与公共依赖制品，未读取真实业务库或 `.env`，未调用真实模型、创建预算、操作 App／微信、打包、修改产品、票或 Git index；未暂存、提交、push 或 PR。
