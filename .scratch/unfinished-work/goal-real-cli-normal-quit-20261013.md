# 最终 C：真实 CLI 入库与正常退出分项（2026-10-13）

最终 C 的正式 SyncHost 在唯一已授权联系人范围内读取固定第 8 条我方测试消息，入库 1 次、来源引用 1 次、重复身份 0；正常菜单退出完成认证停读，全部本场已记录 CLI 与后端退出，五秒后新增读取 0。此结果只通过入库和正常退出分项；微信非前台、对方来信、双联系人、OCR 与原综合场仍未通过。[60 分钟结果](goal-wechat-60m-20261013.md)、[原 04 票](../native-app-backend/issues/04-real-wechat-follow-smoke.md)、[最终 C 组合](goal-final-c-acceptance-20261013.md)

## 固定范围与最小验收改动

复用最终 C ASAR `bb68a80b9c5897ce78e128bf43377238f981fc411c1101a0cfb575afa6f1d685` 和包内真实 CLI 1.6.25／固定 WCDB，未重建包或替换 helper。主 Agent 在约 04:09 使用 Computer Use 核对已授权实际目标、输入和发送气泡，只发送约定第 8 条；目标内累计 **8/12**，本节后三场新增发送 **0**、对方来信 **0**。身份、精确定位和私有发送收据不提交。

正文适配器只接受本场授权定位、该条固定文字及有限时间窗，在本机内存校验；正式后台、鉴权 HTTP 与独立随机 PostgreSQL 测试库仍走生产路径。全局流只记必要元数据，会话列表请求明确拒绝；没有扩大联系人范围、读取其他正文、模型上传或产品发送能力。`cli_background` 是入库模式枚举，不能证明微信当时处于系统后台。

`desktop/tests/real-sync-quit-acceptance.spec.ts` 新增一个独立场，原外部前台综合场前 6308 字节保持原样。新场要求最终签名包、至少两次真实成功 tail、流活跃、当前唯一 fixture 联系人精确入库 1 且重复 0，再沿公开菜单正常退出，验证认证停读／后端与已记录 CLI 退场及五秒无新增启动。默认仍仅显式现场 flag 启用，不减弱原场或用直接 stop 替代产品退出。

## 保留的失败与实际修复

| 场次 | 台北预登记／最多启动 | 实际终态 |
| --- | --- | --- |
| `goal-real-sync-quit-final-20261013-c` | 04:09:25.126771–04:19:25.126771／1 | 1.121045 秒，exit1，App／CLI 0；scope 浮点微秒比 JS 毫秒租约截止多 0.771ms，准备拒绝 |
| `…-c-v2` | 04:11:38.243342–04:21:38.243342／1 | 75.261841 秒，exit1，App 1；时间取整后通过，复制的只读 sandbox 仍只允许旧 helper 目录，实际 CLI return71、tail 接受 0 |
| v3 私有配置准备 | 未启动场次 | 只读权限比较错误把整份 profile 当作 write rule，断言失败；App／CLI 0，保留准备错误 |
| `…-c-v4` | 04:16:33.349613–04:26:33.349613／1 | 96.341565 秒，exit1，App 1；只替换已批准 helper 父路径，版本探测与正式读取恢复，tail 接受 2；Finder 操作后 App 仍未失焦，外部前台等待失败 |
| `goal-real-sync-normal-quit-final-20261013-c` | 04:25:53.654046–04:30:53.654046／1 | **71.309497 秒，exit0，1pass，App 1**；入库／正常退出分项通过 |

v2/v4/正常退出三场均复用已发送的第 8 条，没有为失败重发。修复后的 scope 截止向下取整，严格在各自有限租约内。sandbox 新 SHA `6ef31e973754c26381296e031dae9d874f5c99de1cdcfd44666af9e510a55f68`；原读／写规则其余字节保持，实际写规则仍仅原 `/dev/null`，没有新增聊天写入或网络许可。v3 的错误比较被显式 s-expression 范围核验替代，未声称是产品红绿。

v4 主 Agent 实际操作空白 Finder 的“前往文件夹”和窗口 Raise，工具显示 Finder 列表焦点，但产品 `BrowserWindow.isFocused()` 检查始终不满足失焦条件；未生成正向 external-focus 收据，也未到达正常退出断言。实际按键／Raise 不等于 OS 前台认证，原失败原因不能归为产品同步错误。

## 正常退出实测与清理

结果 `real-sync-normal-quit-results.json`：messageCount=1、observationReferenceCount=1、duplicateIdentities=0、latestMode=`cli_background`，流活跃／至少两次实际 tail 接受；normalQuitExitZero、authenticatedStopped、backendGone、ownedCliGone 均 true。退出时和五秒后实际 CLI 启动数都为 **6**，增量 **0**。externalForeground、newIncomingMessage、twoContactContinuity、sessionListing 全部 false，OCR／模型调用 0。

忽略目录 `desktop/artifacts/goal-real-sync-normal-quit-final-20261013-c/` 保留 session-plan、runner／terminal、scope／只读 profile、audit／pids、results 与 Root 终态；顶层目录 0700，scope／profile／audit／pids 及私有结果 JSON 为 0600。Playwright 的结果子目录 0755 和 `.last-run.json` 0644 位于此受保护父目录内，不能称所有递归权限均为 0700／0600。Root 复核 **9 个记录 PID 消失、2 个自有路径消失、精确自有测试库不存在、后端 exit0、共享租约 absent**。最终 C 的 **280** 个文件 SHA 不变、deep strict 验签 exit0。v2 与 v4 的精确资源及失败清理也分别记录，不以新绿场覆盖。

原已存在但来源未明的测试库不删除；部分其他组合场个体后端收据覆盖不足仍另列，不能据本场声称全历史资源覆盖完整。微信保留用户授权的 8 条测试消息。本分项没有访问业务库、迁移、上传私聊、运行 OCR、调用模型、系统权限／签名变更或远端 Git。

最小验证为真实新场 1/1、TypeScript 检查及差异检查，7 个相对链接有效，执行时源码 SHA 与当前相同。首次 TypeScript 在 contacts 未收窄时报错，补 `Array.isArray` 严格形状拒绝后同入口通过；不把外层最后一个 shell exit0冒充首次检查成功。Spec 最终未解决 0；Standards 首审的评论位置和递归权限措辞两项已修正、增量复核未解决 0，按主题本地提交。原 04 仍 claimed／ready-for-human，仅原故障恢复 AC 已勾；其余条件保留。
