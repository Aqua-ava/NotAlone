# 单张图片取不到时不再关闭共享读取进程核验（2026-11-05）

## 结果与范围

图片 `image-open` 与历史读取共用同一个原生进程；此前一张图片取不到，原生客户端会关闭进程，所有已读完联系人的守卫随之失效，被投影为 `history_source_continuity_unverified`，协调器再逐位重验并建立任务。本次让读取程序按影响范围返回错误码，并在原生客户端只对已查证的单图错误保留进程；同步页另行展示已保存的历史进度。

- **已完成并验证**：Go 错误分类与清理、TS 封闭可恢复集合、制品清单声明、升级配对策略、`saved_history_complete` 只读字段与同步页文案。
- **已构建、尚未启用**：新读取程序 `image-open-local-20261105-v1` 已由正式构建脚本生成，但没有为现有账号生成来源别名，也没有把 `wechatCliPath` 切到新制品；在此之前，运行中的读取程序仍是旧制品，行为不变。
- **未做**：真实微信取图验证、实际桌面 App 的 Computer Use 验收（本次会话没有桌面操作工具）。界面只在本机 Chrome 中渲染真实组件并截图核对。

## 错误分类（`notalone_image.go`）

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 账号、会话、来源代次为空或不符 | `history_image_association_unverified` | `history_scope_unverified` |
| 快照目标与请求不符 | 同上 | `history_target_unverified` |
| 消息守卫失效、无法重建 | 同上 | `history_source_changed`／`history_source_unverified`（原错误） |
| 固定快照关闭、取消、来源代次变化 | 同上 | `history_snapshot_*`／`history_source_changed` |
| 分片重复 | 同上 | `history_target_ambiguous` |
| 查询失败（含取消）、资源库无法打开 | 同上 | `history_image_read_failed` |
| 资源库路径无效 | 同上 | `history_image_source_changed` |
| 解码被取消或超时 | `history_image_format_unsupported` | `history_image_read_failed` |
| 同时打开图片数超限 | `history_image_too_large` | `history_image_request_invalid` |
| 本张图片的消息、资源、候选文件关联缺失，缺文件，内容核验、格式、解码失败 | 原码 | 原码（单图码） |

TS 只把五个单图码（`history_image_association_unverified`、`history_image_local_file_missing`、`history_image_quality_unverified`、`history_image_format_unsupported`、`history_image_decoder_unavailable`）当作 `image-open` 的局部失败，且仅在制品清单声明 `imageOpenIsolation: wechat-image-open-local-v1` 时生效；客户端选项声称隔离、但制品清单没有该声明时，在启动原生进程前即被拒绝。

## 构建与升级

- 使用 `node desktop/scripts/build-history-cli.mjs` 并以锁定 Go 1.26.5 归档（SHA-256 与锁文件一致）、既有 WCDB 构建；输出 `image-open-local-20261105-v1`（位于本工作树被忽略的 `local-tools/wx-cli/.notalone-builds/`），未打包 App。
- 新旧清单只差三项：`cliSha256`（`e788c3b1…`）、`overlaySha256`（`49069c6b…`）和新增的 `imageOpenIsolation`；WCDB、补丁、官方源码树均不变。
- 新旧源码只差 `notalone_image.go` 与其测试；协议文件和五个来源身份文件逐字不变，升级策略 `imageOpenLocalPolicy` 因此无来源身份更新。`prepareAliases` 按该策略只接受 `image-pick-standard-20261105-v1 → image-open-local-20261105-v1`。
- 启用前仍须按既有流程：为现有账号生成来源别名与凭证、逐项核验现有授权会话、再把 `wechatCliPath` 指向新制品并经 `pnpm run dev` 重启。本次没有执行这些涉及真实账号的步骤。

## 自动验证

| 检查 | 结果与覆盖 |
| --- | --- |
| `go test -race -json -count=1 -p 2 -run '(?i)notalone' ./cmd/wechat-cli ./internal/wcdb` | 431 通过、1 项既有的真实安装程序版本检查跳过、0 失败；含真实来源错误不被降级、并发打开超限、单图失败后无令牌和描述符泄漏。 |
| 泄漏用例的敏感性 | 分别去掉资源守卫、候选守卫（关联分支与解码失败分支）的关闭后，用例均失败，证明用例确实覆盖这些清理路径。 |
| 后台历史、图片、微信相关 `node --test` | 518 项中 517 通过；唯一失败 `manual正式profile不自动派发历史或记忆…`（记忆处理启动返回 409）在改动前的提交 `05196d797` 上同样失败，与本改动无关。 |
| 桌面 `node --test`（状态解析、同步范围、联系人历史视图、升级与构建脚本）及本机 Chrome 的 Playwright 视图用例 | 45 项通过。 |
| 后台与桌面 `tsc --noEmit` | 通过。 |
| `node scripts/check_public_history.mjs --ref HEAD --working-tree` | 0 个问题。 |

## 同一负载对照（合成原生进程，真实 SharedWechatClient、WechatHistoryChannel、SqliteHistoryService 与 SQLite）

先让全部联系人读完历史，再注入图片 `image-open` 失败。

| 联系人数 | 制品 | 图片失败次数 | 原生进程代次 | 守卫失效联系人数 | 历史页读取数变化 | 额外 target／resolve |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 声明隔离 | 16 | 1（不变） | 0 | 0 | 仅图片请求自身的 16 次 |
| 100 | 声明隔离 | 16 | 1（不变） | 0 | 0 | 仅图片请求自身的 16 次 |
| 10 | 旧制品（对照） | 1 | 重建 | 10 | — | — |
| 100 | 旧制品（对照） | 1 | 重建 | 100 | — | — |

来源类错误（`history_source_changed`）在声明隔离的制品上仍关闭进程，全部联系人退回待重验。该对照不代表真实聊天读取耗时。

## 进度展示

同步页改为“已保存本机历史：X / Y 位联系人”，另行显示正在读取、正在同步新消息和“聊天来源待重新核验，已保存的聊天不受影响”；旧后台缺字段时显示“进度待确认”并不画进度条。`saved_history_complete` 只读，回复资格仍只看覆盖阶段；真实来源围栏下该字段仍为真但 phase、正文资格和来源警示不变。图片重试累计次数只用于调度，`cli_backfill_failed_contacts` 固定为 0，未被当作联系人故障人数。

## 限制

没有用真实微信数据验证单张图片的真实失败原因；隔离只改变失败的影响范围，不降低图片关联要求，也不保证每张图片最终都能取得。
