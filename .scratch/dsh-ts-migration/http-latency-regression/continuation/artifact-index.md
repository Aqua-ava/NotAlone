# 冻结诊断证据索引

精确公开清单以 `final-public-manifest.json` 为准；SHA在 `FINAL-PUBLIC-SHA256SUMS`。这次只冻结诊断阶段，不批准HTTP性能。

| 问题 | 结果与入口 | 驱动与边界 |
|---|---|---|
| 当前产品安全源码 | `current-safety-checkpoint.json`、`safety-password-final.log`、`typecheck-password-binding.log` | host/test已由root提交1e90；产品没有本任务残留改动 |
| 完整生产HTTP | `http-production-01.json`、`http-production-02.json`、`http-production-03.json`及各summary | 对应同前缀脚本；每case 10/30，不能拼接挑选成功样本 |
| 连接/文件/结构成本 | `connection-counterfactual*.json`、`root-snapshot-cost.json`、`isolation-cost.json`、`catalog-projection.json`、`catalog-oids.json`、`sql-flags.json` | 仅诊断；首次exit13及RED/GREEN记录保留；不替代HTTP |
| 实际DSH路径trace | `http-lease-trace.json`、`http-sql-profile*.json`、`sql-profile-after-new-trace.jsonl`、`cpu-profile-summary.json` | 自有源码/连接观察；不能把插桩结果冒充未插桩门禁 |
| framework/minimal | `http-framework-counterfactual.json`及summary、`counterfactual-metadata-corrections.json` | `http-framework-counterfactual.py`、`minimal-contact-host.mjs`；两GET/320采样；原metadata错误通过补充更正 |
| H1固定空闲 | `http-startup-idle-counterfactual.json`及summary | 同名py；仅ready后2秒空闲，全功能480采样，无一致改善 |
| H2版本串文本 | `row-text-findings.md`、`row-text-analysis.json`、`row-text-attempt01-preparation-failure.json`、`row-text-safety{-02,}.json` | `http-row-text-counterfactual{-02,}.py`、`row-text-probe{-01,}.mjs`、候选patch；root拒绝采纳 |
| H2公开小清单 | `row-text-evidence-manifest.json`、`ROW-TEXT-SHA256SUMS` | 此子清单在本阶段总冻结前形成，原内容保留 |
| 输入/loader/出站边界 | 各HTTP JSON的source/binding/environment记录；冻结合成plan与dump仍在授权state目录 | `http-production-instrumentation/{new-host,perf-preload}.mjs`、同目录旧臂适配器；产品`launch.ts:146–162` |
| 原始输出与脱敏 | `private-log-bindings.json`、`privacy-remediation.json`、`row-text-privacy-check.json`、`final-public-verification.json` | 仅公开相对别名及双SHA；原始输出不纳入staging |
| 交接 | `final-handoff.md`（不超过40行） | 后续完整宿主边界交给新会话，本会话不再启动流程 |

冻结文件中的历史状态（例如候选曾待测试、旧阶段正在运行）按原样保留，最终状态以 `final-handoff.md`、当前检查点和对应新阶段JSON为准。不能回写早期失败、未知结果或错误metadata来制造一致历史。
