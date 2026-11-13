# 第5项验收：特殊用例逐项固定版本对照

日期：2026-11-11 至 2026-11-12。状态：完成。两项均已在三个固定源码版本逐项执行，并用两个独立控制排除同提交混入的诊断改动。未修图片生产代码或旧快照断言。

## 固定版本与范围

- `git rev-parse 57b0c1611^` 实际返回 `33b66ca7c3f68792a3088205c2dfef494f7cb257`，作为首个诊断提交前基线。
- 当前源码固定 `9304b8cece0f0b8f922231b6cb5af81b6bd3b016`。
- 图片因果版本固定 `1f8f647043ab887685fefd8359e639567c0a7d3e`，其父为 `8100de58fdf8e56eec450075ce276ef370c1fa23`。
- 每个版本分别执行 `git archive <ref> backend-ts native/skill-read pnpm-lock.yaml reply-skills`，解压到真实路径私有目录；目录 0700、文件 0600，仅链接既有 `node_modules` 和原生只读器 `.build`，未安装或构建。
- 所有 SQLite、凭据、图片及模型响应均为测试内合成。ModelHost 端口只指向测试 127.0.0.1 供应商；正式 profile 使用 `backend-ts/test/fixtures/sqlite-memory-profile-network-guard.mjs:8`、`:17`、`:23` 的回环校验、socket 限制及固定端点重定向，未访问真实模型或用户数据。
- 最初 profile 归档漏带 `reply-skills`，产生资源缺失的准备错误；补齐每个固定版本自身的静态资源后，以下三次 profile 结果均为重新实际执行。准备错误不计为产品失败。

## 逐项实际结果

| 用例 | 文件与测试定义行 | 诊断前 33b66ca7c | 当前 9304b8cec | 图片 1f8f64704 | 固定失败断言 |
| --- | --- | --- | --- | --- | --- |
| 官方DSH和真实ModelHost端口：用途、凭据、最终预算、未知禁重发与迟到资格 | `backend-ts/test/sqlite-memory-model-port.test.mjs:66` | exit 0，pass 1 | exit 1，fail 1 | exit 1，fail 1 | `:139` 预期 `image/png`，实际 `image/jpeg` |
| 正式SQLite profile的图文后台在途时前台已到共享供应商，来源图片和统一台账保持隔离 | `backend-ts/test/sqlite-reply-background-concurrency-profile.test.mjs:44` | exit 0，pass 1 | exit 1，fail 1 | exit 1，fail 1 | `:118` 预期原 PNG 字节，实际规范化 JPEG 字节 |

以下命令分别在每个版本私有副本的 `backend-ts` 目录执行，共六次；均保留进程真实退出码，非代表用例外推：

```sh
node --test --test-name-pattern=ModelHost test/sqlite-memory-model-port.test.mjs
node --test --test-name-pattern=profile test/sqlite-reply-background-concurrency-profile.test.mjs
```

最新完整后台结果由独立全量验收记录提供：2301 总计，2288 pass，11 fail，2 cancelled，exit 1；此分组只接管上述两项，其余图片资格／生命周期 11 项见 `acceptance-20261111-tests.md`。本轮没有新增其他非图片失败。

## 因果控制与代码依据

图片提交同时混有 `service.ts` 三处诊断改动，不能仅据提交标题归因。另建两个私有副本，对上述两项分别执行同一原测试命令，共四次；所有副本两份测试文件逐字节未改，哈希已记录。

| 独立控制 | ModelHost | 正式 profile | 生产文件差异核对 |
| --- | --- | --- | --- |
| 图片 1f8f64704 保留图片变更，仅恢复其父版本的三处日志改动 | exit 1，同 `:139` PNG／JPEG 断言 | exit 1，同 `:118` PNG／JPEG 字节断言 | 仅 `memory/sqlite/service.ts` 三处日志不同 |
| 当前 9304b8cec 保留全部当前诊断代码，仅恢复图片变更前的图片行为 | exit 0，pass 1 | exit 0，pass 1 | 仅七个图片生产文件变化；`service.ts` 当前诊断 import、自动处理原因事件、trace wrapper 三处完整保留并逐行匹配 |

七个恢复的图片文件为 `memory/content/image.ts`、`memory/extraction/flow.ts`、`memory/extraction/multimodal.ts`、`memory/sqlite/content.ts`、`memory/sqlite/service.ts`、`platform/models/image-normalization.ts`、`platform/models/model-images.ts`（均在 `backend-ts/src/` 下）。其它当前生产源码逐字节一致。其中 `image-normalization.ts` 在旧版本不存在，控制中移除。

当前源码的具体因果：`platform/models/image-normalization.ts:51` 使用 `.jpeg(...)`，`:54`、`:79` 明确返回 `image/jpeg`；`platform/models/model-images.ts:45` 发送 JPEG mediaType；`memory/content/image.ts:43` 对来源图片执行该规范化。图片版本到当前版本的这七个文件，除 `service.ts` 诊断 import 模块由 unified 改 context 外一致。失败断言仍固定要求原 PNG，独立控制证明两项失败来自图片规范化与旧快照契约冲突，不由本轮诊断日志相关代码造成。

限制：原测试在该断言处提前退出，不能将本次失败执行视为后续所有断言已完成；诊断前与保留当前诊断代码的图片恢复控制均完整 pass。图片契约与快照的最终取舍仍交由图片任务 owner，本验收未改它们。

## 证据与清理

纯统计证据保留在 `/private/tmp/notalone-unified-final-special-cases-20261111.json`，权限 0600，含六个固定源码结果、四个控制结果、真实命令／退出码、测试哈希及控制范围，不含图片 base64、正文或模型原响应。

清理前 `lsof +D` 返回 exit 1、引用 0；已删除全部五份自有私有副本、原始 payload 日志及本轮指针，清理总字节与日志数见纯统计。未删除 root 或其它 Agent 的临时资源。工作区仅保留既有三处 WIP；未修改仓库生产／测试、不提交、不 push。此记录 ignored，不 force-add。
