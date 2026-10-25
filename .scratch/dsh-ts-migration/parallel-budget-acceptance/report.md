# 独立物理预算接口验收

日期：2026-10-25。固定候选 **`a61a21407c9395c462e4e68bfeee4628e7e9b15c`**，比较基点 `611292975cbfb614f23f2d4b994700a2eb12620b`。执行前后 HEAD 相同，45 个来源／接口依赖文件哈希零漂移；两份实现方冻结清单逐项相符。结论只适用于本次接口范围。

## 标准结论

通过；未发现本范围新增的 P1/P2 阻塞。只写本目录中的独立脚本、摘要与报告，生产源码、原测试及既有证据只读；未操作共享 index、提交、桌面或真实资料。`host-model-accounting.ts` 及 PG schema 未因本预算切片改变。

预算模块只读问题、轮次与停止条件，唯一持久更新为 `used=used+1`（`backend-ts/src/diagnostic-problem-budget.ts:43`、`:69`）；不接收正文、凭据或联系人字段。独立组合用例还检查 SQLite 字节不含合成范围 ID、请求内容／工具名和 provider 地址。日志均在仓库外 0700 目录、0600 文件；合成 PG、私有账本、自有子进程和 HTTP 服务已清理。

TS 使用 Node v24.19.0 内置 SQLite，产品预算模块不启动 Python。Python 3.12.15 仅用于本次合成互操作管理。未评价腾讯记忆算法或真实语义质量。

## 规格结论

本范围通过，独立实际运行 **18/18**，失败 0。真实外部模型调用 **0**；以下 HTTP 数均为本机假 provider 实际收到的请求。预留、HTTP 与 PG receipt 分开统计。

独立组合脚本从既有 Python CLI 创建一次性合成账本并在 Python 预留一次，随后使用生产 provider／accounting 和既有实际提取、L2/L3 caller：

| 检查点 | 累计预留 | 实际 HTTP |
| --- | ---: | ---: |
| Python 先预留 | 1 | 0 |
| PG 拒绝后 | 2 | 0 |
| PG 预约后取消 | 3 | 0 |
| HTTP 503 后 | 4 | 1 |
| strict 核验后 | 5 | 2 |
| 普通发送后 | 6 | 3 |
| 停止旧进程、换目录启动后 L2 | 7 | 4 |
| L3 使用最后额度 | 8 | 5 |
| 第九次拒绝后 | 8 | 5 |

此场景为 4 次 Messages、1 次 strict HTTP；6 条 PG receipt 来自 6 个 permit，unknown 为 0。第九次 HTTP 增量 0，停止 caller 后未确认许可为 0。失败、PG 拒绝与预约后取消均没有退款；Python 的一次预留不会冒充一次 HTTP。逐步计数见 [独立结果](independent-wire-result.json)。

| 其他独立复核 | 结果 |
| --- | --- |
| 两进程并发竞争 12 次发送 | 预留 8、HTTP 8，额外尝试零出站 |
| E、strict-V、B、关系、合并、L2、L3、学习 | 同一总账共 8 次；L3 后续拒绝无孤儿许可 |
| PG 预约等待期间截止 | 预留 1、HTTP 0；`cancelled / not_sent`，无新增 unknown |
| 有效 PG reserve ACK 被代理破坏 | 预留 1、HTTP 0；保留原 pending receipt 与未知 permit，settled 尝试 0 |
| 旧 observation 缺少新字段 | 已用 8、HTTP 0；保持未知许可，不能把缺字段当明确未预约 |
| 已有 transport unknown 后换进程 | 预留从 1 到 2、HTTP 仍 1；原 unknown receipt 原样保留 |
| 截止、上一轮未结案、连续两轮无改善 | 普通／strict 均在 PG 新预约前拒绝，预留与 HTTP 增量 0 |
| Python／TS 并发与轮次管理 | 共用 SQLite 写锁和累计数；未结案及连续无改善阻止后续 |
| 两变量缺省／半配置 | 正常路径 9 次 HTTP 且不创建诊断账本；半配置拒绝 |
| 绑定后撤变量／换文件／公开权限 | 原限制不能解除；文件替换与权限变宽直接拒绝 |

交叉接口已同时检查：`model-provider.ts:87`、`:144` 各在物理准备处预留，原 PG 回调前同步把 `before_dispatch_started` 置为 true，回调返回后复验；`l2-scenario-model.ts:270` 仅显式 false 可按确定未预约收尾，true／缺省保留 unknown。实际 ACK 丢失用例精确保留 `l2_scenario_model_ack_unknown`；未因错误码不同就判断不变量失败。

新增腾讯 L2/L3 入口复核确认 `claim`、owner/contact 范围、batch、binding、profile、signal 和 `requireCurrent` 透传，预约前失败与 ACK unknown 原错误对象／空 receipt 原样返回，各只调用一次 port，不在入口重试（`l2-scenario-workspace.ts:708`、`l3-profile-workspace.ts:779`）。此项是入口合同验证；物理／PG 行为由上述实际 caller 用例覆盖，不能合称为完整业务或真实质量验收。

## RED → GREEN 与 P1/P2 证据

先只读核对实现方原始 RED 输出：第九次仍可发送、PG 等待跨截止仍可发送、L2 预算拒绝被报成 ACK unknown。历史 RED 未在本会话重放，未修改旧版本；实现方最终 32 项与 TSC 仅作为其证据。随后在本候选独立运行相关用例及新组合复核，全部 GREEN。当前未复现新的 P1/P2；上述历史风险已由发送处预留／复验及 L2 明确回调标记收尾解决。真正 ACK 丢失及旧 unknown 的保守阻断仍通过反向用例。

## 实际命令与来源

每次均使用 `PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/miniconda3/envs/NotAlone/bin:$PATH"`，不激活 Conda。完整 argv、工作目录、超时、退出码和私有日志 SHA-256 见 [执行记录](execution-record.json)。执行顺序为：

1. `backend-ts/`：`node --test --test-concurrency=1 --test-name-pattern='有效预约 ACK 丢失' test/diagnostic-model-budget.test.mjs`（1/1）。
2. 仓库根：`node --test --test-concurrency=1 .scratch/dsh-ts-migration/parallel-budget-acceptance/independent-wire.test.mjs`（2/2）。
3. `backend-ts/`：对 `test/diagnostic-model-budget.test.mjs test/diagnostic-problem-budget.test.mjs` 使用执行记录中的精确 `--test-name-pattern`（13/13）；未重跑旧完整套件。
4. 仓库根：`node --test --test-concurrency=1 .scratch/dsh-ts-migration/parallel-budget-acceptance/tencent-port.test.mjs`（2/2）。

根已报告联合 TSC 通过；本会话未重复 TSC，未把实现方的检查计入 18 项。初始读取与冻结后的全部哈希分别见 [准备清单](preparation-manifest.json)、[验收来源清单](tested-source-manifest.json)。关键源码 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `backend-ts/src/diagnostic-problem-budget.ts` | `6bb10e2a4cbc1572970ea2dccc08e94f96c179f95f430a4ab169322ca2e449e8` |
| `backend-ts/src/model-provider.ts` | `98e7026309d74442e92d47bab0a63006b2b26364b4840908c9578391b5db9311` |
| `backend-ts/src/host-model-accounting.ts` | `b2ea52b7cda43e20aa12f82bce756ece5a6e8bc76239c41d31c1910a51e74454` |
| `backend-ts/src/l2-scenario-model.ts` | `c387b457ac8d4b3b65433b15e6e85b075a889d4d0eb284db5b91a874efc4c41c` |

## 精确启用条件与限制

根须锁定原问题 ID、同一绝对私有账本路径与轮次，保留累计数，记录新统计起点及此前调用次数 unknown。账本必须既有、文件／直接父目录归当前用户且无组或其他权限，按 0600／0700 配置；本会话的合成账本不能用于真实问题。既定八次／三十分钟不自动扩额、续期或更换问题编号。

两个变量须在 provider 安装前进入实际 DSH 进程的 OS 环境；后来在外部 shell `export`、修改其他配置文件或换请求字段不会给既有进程增加保护。根应核验实际启动配置，继续遵循开发实例复用和 `npm run dev` 门禁。

本预算只覆盖已接入 provider 的 TS 发送；Python 仍须使用原受控总账入口，不是全局网络防火墙。它不识别故意换 env／新问题名／手工清零，不能替代固定问题配置、供应商授权、单联系人范围、来源与删除保护。原未知任务必须先由原写入方核对，额度可用不授予换 task/window 重放资格。

条件满足后可由根进行原授权范围内的小批诊断；本报告没有启用任何真实配置，不证明真实质量改善、实际 App 闭环或 Ticket 25／26 通过。费用暂豁免没有扩大预算或权限。
