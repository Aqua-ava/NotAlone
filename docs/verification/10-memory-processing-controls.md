# 票10 记忆处理控制与恢复：验收证据

日期：2026-10-30。范围：票10 第14条「隔离正常入口与真实页面覆盖暂停小批收尾、单人失败/共用故障、退出重开、成功步骤复用、unknown、租约接替和删除晚到，核对界面、账本与可检索内容一致」的后端与实机验证。真实微信、真实模型、真实业务库、打包均未使用。

## 验证方式

- 后端：真实 SQLite、真实 `SqliteMemoryExtraction`/存储动作、真实 05 删除与 06 清空服务；仅模型供应商与精确时序使用替身。
- App：真实热更新开发 App（`/tmp/t09-node/bin/node desktop/scripts/dev.mjs --user-data-dir <隔离根>`，CDP 驱动），隔离 userData 合成 SQLite（schema 15，`sqlite-development.json` capabilities `contacts,history,memory`），同步单批合成联系人后停止读取；未操作微信、未加载真实配置。
- 供应商替身：仅在供应商传输边界使用本机环回 HTTP 供应商（`127.0.0.1`，临时进程）；测试专用网络守卫把官方模型地址重定向到该环回地址并拒绝其他出站，等同 09 已使用的合成 App 方式。替身为 `/private/tmp` 临时脚本，未提交进仓库，也未新增产品开关或模型/凭据入口。
- 模型配置仍走产品 `resolveHostReplyConfiguration` 与既有 DSH 模型宿主；环回只替换已授权请求的传输目标。

## 实机场景与结果（截图/日志为端侧临时证据，不入库）

1. 开始→处理中→普通暂停→小批收尾→已暂停→退出重开→继续复用（合成甲25条+乙2条，首批停住）
   - 开始后处理中：待处理27、调用 prepared/sending 正常，页面显示“正在提取与核验”。
   - 请求暂停：界面立即显示“已暂停”；随后首批 20 条提交，显示“已处理 20 / 27 条文字目标”“待处理 7 条文字目标”“继续原任务”，无百分比、无“本轮已完成”。
   - 暂停后供应商仅收到 1 次提取调用，未启动下一批。
   - Cmd+Q 正常退出：`dev:status --user-data-dir <根>` 为 `{"mode":"stopped","pids":[]}`；同根重开：状态保持“已暂停”（succeeded 20、pending 7、actions `continue`）。
   - 继续：全部 27 条目标处理完成（27/27、pending 0），供应商提取响应窗口总数 3（甲2批+乙1批），首批未被重复提取；界面无百分比、候选待用户决定时未显示整轮完成。正常退出后清理为 stopped/pids[]。
   - 截图：`/tmp/t10-app-shots/10-1-processing.png`、`10-3-paused-batch-finished.png`、`10-4-reopen-paused.png`、`10-5-continued-reuse.png`；日志 `/tmp/t10-app-run-pause.log`、`/tmp/t10-app-dev-pause.log`、`/tmp/t10-app-seed-pause.log`。
2. 单人失败 vs 共用故障固定原因（甲2条+乙2条）
   - 对乙的核验返回合成“不确定”：乙任务 `failed`（`memory_extraction_source_insufficient`），甲继续完成 2 条；界面“部分联系人处理受阻，可继续重试”，actions `continue`。
   - 继续且恢复正常供应商后：全部 4/4 完成；已成功的甲提取调用数保持 2（未重发），仅补发乙的核验调用（base 核验 1→2）。界面通过“刷新”显示 4/4。
   - 共用供应商 500：整轮显示固定原因“模型配置或服务不可用：模型服务暂不可用。修复后可继续。”，actions `continue`；等待 4 秒无自动重试（供应商调用数不变）；修复后手动继续完成 2/2。
   - 截图：`/tmp/t10-app-shots/11-1-contact-failed.png`、`11-2-completed-after-retry.png`、`13-1-shared-fault-fixed-cause.png`、`13-2-shared-fault-recovered.png`；日志 `/tmp/t10-app-run-failure.log`、`/tmp/t10-app-run-shared.log`。
3. unknown 回执不显示继续、不自动重发（甲1条+乙1条）
   - 供应商收到请求后断连：两个任务均以 unknown 保守记录；界面“调用结果待核实”“有 2 条目标调用结果未知，核实前不会重新发送”，无“继续原任务”，无百分比/伪完成。
   - 等待 5 秒供应商调用数不变；刷新后仍为 blocked/model_receipt_unknown、actions 空、unknown 未清；正常退出 stopped/pids[]。
   - 截图：`/tmp/t10-app-shots/12-1-shared-fault-unknown.png`、`12-2-unknown-refresh.png`；日志 `/tmp/t10-app-run-unknown.log`。
4. 后端覆盖（真实入口、环回/替身边界之外）
   - `sqlite-memory-control.test.mjs` 16/16：统一状态/历史失败不冒充当前、暂停小批收尾、暂停期间取消、取消勾选撤销本人贡献、05 来源删除晚到、06 清空晚到与新消息新资格、退出重开保持暂停、已知回执复用、unknown 不清不重发、租约接替与旧回调拒绝、控制修订 CAS 与读查询纯读、无固定目标不误报、发送中不误报 unknown。
   - 09 文档独立用例复跑（含“暂停后不启动后续文档小批”“共用配置失败不启动他人文档”）通过；06 清空/重读用例通过。
5. 本次实机发现并修复的产品问题（两处，均已有回归）
   - 在途 `sending` 曾被控制投影误判为 unknown，导致真正处理中被显示“调用结果待核实”；已改为仅 `unknown` 状态算未知，新增在途发送回归。
   - 没有固定目标时曾投影为“范围已失效”；已改为“当前没有待处理的文字目标”。
   - 共用故障原因码此前仅在 `statusReason` 与后台，界面补充固定原因展示（`sharedFaultCode`）。

## 未在 App 内构造的项与理由

- 租约接替：需要真实执行者中断/接管时序；产品 App 无对应操作入口，改由控制测试中真实 SQLite 租约、旧领取者迟到回调拒绝用例覆盖。
- 取消勾选/清空后不恢复内容：App 内构造需要真实联系人取消与渠道边界（当前隔离根不接微信）；由后端真实 02 取消、05 来源删除、06 清空服务用例覆盖，删除晚到/清空晚到均已验证不恢复内容。
- 真实模型质量、真实微信数据、最终产品切换未认证，单独记账；本文的供应商是传输边界替身，不证明供应商语义或真实网络条件。

## 复跑命令

```bash
# 后端（Electron Node，backend-ts/）
ELECTRON_RUN_AS_NODE=1 <desktop>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  --test test/sqlite-memory-control.test.mjs          # 16/16
pnpm run typecheck                                    # 0

# 桌面固定处理（desktop/）
pnpm exec tsc --noEmit                                # 0
node --test tests/fixed-memory-processing.test.mjs tests/fixed-memory-processing-view.test.mjs \
  tests/memory-processing-entry.test.mjs tests/memory-page-fixed-processing.test.mjs   # 23/23
node scripts/test-inventory.mjs                       # 登记通过
```

## 结论

票10 第14条在「可安全执行的真实页面范围」内通过：App 内真实完成统一状态、暂停小批收尾、退出重开保持暂停、继续复用成功步骤、单人失败与共用故障固定原因、unknown 不提供继续且不自动重发，界面与后端口径一致；未构造项按上节边界记录，不冒充真实模型或真实微信通过。
