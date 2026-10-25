# 同键准备重试停止修复

本轮仅处理冻结 Standards 发现的 P2。输入审查 manifest SHA256 为 `0a0790358c539d647b09a3230b10c0640ba39eca618a4b83e1fceaf86003d68a`，与委派记录一致。旧 `implementation/` 和冻结审查文件未改。

## 原因与最小修复

首次准备响应丢失后，旧登记的传输已结束，但缺少权威终态，必须作为 unknown 保留。同请求键重试会新增准备登记；`states()` 按同键覆盖为最新登记，停止却用正向 `Map.find()` 命中旧项，立即报身份未确认。新准备仍继续派发。

生产 `ReplySession → installReplyBridge → preload → AssistantSessionPanel` 与作业级反例均在修改前业务 RED；本轮还将工作区 express 同键重试反例加入已有 IPC 测试。旧失败保留在 `red-review-jobs`、`red-review-ipc`、`red-promoted-ipc` 等日志中。

只把停止的匹配查找改为反向，保持与同键可见状态一致；connection、owner 范围、contact、session、request、input version 的原检查不变，没有添加删除 unknown 或猜测未领取的分支。

继续保持新准备阻塞，让原执行经真实 `protocol.observe({ kind: 'receipt' })` 回调收到晚回执，并让退出任务运行至实际等待点，又复现旧回执抢先 `app_quit` 的交错。修复让旧登记的退出／重载只等待同一认证范围和同一请求键的既有用户停止；实际回执匹配后仍由原有权威逻辑收口。未领取证明、失败、未知、来源校验和取消权限不放宽。无停止意图时保留原快速返回，避免增加正常退出的等待层级。

## 交付范围

- 产品只改 `desktop/src/main/reply/assistant-generation-jobs.ts`。
- 回归只加入两个已有且已登记的测试：`assistant-generation-preparation-stop.test.mjs`、`assistant-generation-stop.test.mjs`，inventory 原第 14/16 行已包含，字节未改。
- 新增 4 个回归：工作区同键重试 IPC；同键选择并保留旧未知到真实回执；晚回执先于停止与退出；晚回执后于停止与退出。
- 没有新框架／队列、PG／DTO／后端协议或其他产品源码变更。三个用户测试文件与 98 份初始冻结证据 SHA 均未变化，index 指纹未变。

## 实际验证

所有命令和当时的源码 SHA、HEAD、index 指纹、原件／脱敏副本双 SHA 均在各运行 JSON。

- `red-review-jobs` 与 `red-review-ipc`：各 0/1，停止报身份未确认，生成计数／POST 为 1，中断为 0；真实模型为 0。
- `red-promoted-ipc`：实际 workspace express 与原键 retry 为同一业务 RED。
- `red-late-receipt-held-current`：仅改登记选择后，真实晚回执／退出任务仍可抢先中断；不是靠立即返回准备来掩盖竞态。
- `related-stopping-green`：5 个相关停止／IPC／准备／执行模块，48/48。
- `independent-boundaries`：冻结审查的两个原 RED 加设置重载／未知中断／错回执／IPC 角色闭合，6/6。
- `desktop-typecheck-final`：`tsc --noEmit` 通过。
- 原先快速退出用例在中间修复增加微任务等待后失败；单例复现并恢复空停止集合的快速返回后通过。未改该测试或掩盖旧失败。

同键工作区重试最终记录为 `stopError=null, modelPostsBeforeCleanup=0, interruptsBeforeCleanup=1`；两个晚回执交错均为 `confirmed=true, modelCalls=0`，只收到当前 retry 的一次 `user_cancelled`。旧未知只有收到真实匹配回执后才由原逻辑收口；旧协议回调在收口后再到达被拒绝，不能复活登记。

没有全量测试、真实模型、实际 App、微信、原资料／`.env`／凭据／账本访问，没有创建或查询 PG，也没有外部发送、add／commit／push／PR。本轮只有一次性 Node 测试和合成传输，无自有常驻资源待清理。原始日志仅在仓库外 0700 目录／0600 文件，仓库只保存脱敏输出与双 SHA。

共享 HEAD 由父任务从 `7a1f58a679245c6df84d88dfaafc3ff2c352c290` 前进到 `a449fd873a456f8773bdf582b076b0eb473a7f51`；三个候选文件的两个基线字节相同。最终验证的源码前后指纹稳定。精确原／新 SHA 和可暂存的三个源码路径见 `manifest.json`、`source-staging.json`；补丁包含且只包含这三个文件。

本候选已冻结。根任务继续独占 index 和实际 App 验收；日常仅可复用 `npm run dev`，不得打包或运行 packaged。记忆语义 deferred、费用输出豁免均保持。
