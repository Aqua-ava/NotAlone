# 10 主树整合与验证

日期：2026-10-25（Asia/Taipei）

## 接受范围

独立会话基于主树 `8ce975e8` 交付默认 A 纵切、唯一提取 Worker、owner/contact
进度和增量观察持久调度。主树通过 merge commit `c33d19da` 接收其双父整合提交
`11dbf063`；53 个文件均来自该提交，`host-plugin.ts` 与 `host-reply.ts` 同时保留
07 探索、23 设置/用量、分层路径和 10 提取入口。

冻结与 Worker 来源：

- 冻结纵切：`f07d7e405f35f75f50e0e6ebdcc3c6f2ab957484`。
- 唯一 Worker/owner 进度：`f8bdde0bc0a4a907230e9316751e60b2fe5bc23f`。
- 可接收补丁 SHA-256 见同目录 `audit.md` 与两个 patch 文件。

主树接收后的 closeout 纵切：

- `1195aff8`：补齐 memory-processing 显式恢复入口，POST body 严格校验，不启动 Worker。
- `a6dd5623`：恢复路由只在精确路径读取正文，保留其他 POST 的后续处理。
- `4c936d1e`：迁移 `bounded-runtime-v1` 的 grounded-v2、nullable-proof-v3 和 v4 有限依据。
- 累计补丁 `task10-owned-closeout.patch.gz` SHA-256：
  `ad7017dfe87759199e00ac3599548b2da73433f6e568a687437cdee5b3ad8b74`
  （解压后补丁 `e9b76f45f19568a26200e3653d0dccc72a1f341faafe21cb08135497d1fabe80`），
  已对 base `e9dd6e39` 在独立 worktree 做 `git apply --check`。

## 主树验证

| 验证 | 结果 |
| --- | --- |
| bounded 批处理集成 | 2/2；E/V 各一次、ALL/v4 依据及 trace/result 恢复通过 |
| backend-ts `tsc --noEmit` | 通过，0 错误 |
| 15 个 extraction 测试 | 52/52 通过，0 skip |
| 许可/队列/来源/恢复组合 | 31/31 通过 |
| 联系人概览相关 | 11/11 通过 |
| `sync-incremental-store.test.mjs` | 11/11 通过 |
| 相关 Python 单元测试 | 44/44 通过 |
| 官方 profile/原生 adapter/真实 ModelHost/PG | E→V 单 attempt、唯一账本、claim 与 trace 回执通过 |
| bounded 物理调用账 | 合成外发 0；调用 2、receipt 2、ledger 2、trace call 2，恢复不增长 |
| 临时 PG 数据库清理 | 测试夹具自建后普通 DROP，无残留测试库 |

第一次主树验证错误地把测试集群放在非默认端口；Node 测试夹具用默认 `/tmp` socket
创建数据库，导致“database does not exist”。这是测试运行环境错误，不作为产品
RED 或 GREEN。随后停止 App 和真实实例，将保留的合成测试集群正常启动在 5432，
在不接触 `notalone_dev` 的前提下完整重跑，上述通过结果为准。

## 未完成边界

- 主生产 host 尚未启动 `ExtractionWorker`；Python `TaskHost` 仍是当前唯一领取者。
  这是有意的单向切换前置，不能由模块测试通过替代。
- 切换前必须停读、排空旧 Worker、复验租约，并提供票 11/12 的 B 采纳、trace、
  watermark 与 index/verify 执行器；当前 Worker 不伪造这些义务。
- TS resume HTTP 和 historical bounded/nullable-proof 已在合成 PG、固定 Python
  oracle 与 loopback/合成调用中验收；实际 App/微信、真实模型质量与费用尚未验收。
- bounded 结果仍由原 Python B 段消费；若 receipt 或 batch_end 未确认，保持
  unknown/不重放，不能把缓存恢复视为采纳完成。

因此 10 保持 claimed；本文件只接收已证明的 A 纵切、队列/Worker 组件和 owner 进度，
不宣称整票完成。
