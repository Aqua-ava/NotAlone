# Ticket 25 根桌面临时证据

日期：2026-10-25（Asia/Taipei）；基线 `4426c6e5`。只记录结构化状态，不保存截图、聊天正文或候选正文。

## 运行与范围

- 开发 App 由 `npm run dev` 启动，五个业务开关均设为 `typescript`；`/api/runtime/status` 返回
  `runtime=dsh`、`state=running`，回复、任务管理和跨域删除所有权均为 TypeScript。
- 顶部联系人搜索只选 `cloudy`；当前联系人显示 174 条消息、唯一 active 微信绑定和“消息历史覆盖：完整”。
- 同步设置显示全部微信私聊范围（291 个已确认会话）和后台同步开启；同时明确显示部分会话因
  私聊身份暂时不能核验而停读。没有把该受阻状态冒充为全量同步成功。

## 真实模型候选

- 手动确认 `cloudy` 后点击“帮我想想”：HTTP 物理回执
  `377317b5-81da-4bbb-9c32-55765a30b481` 成功，15,070/471 tokens，3,461ms，费用口径未知；
  reply request `ebe3918f-fb50-42a4-8125-1788dd33d26a` 与三个候选均持久完成。
- 首轮读取曾错误把 completed turn/input 投影为 unavailable。根定位为已有渠道 active binding
  与手动确认 ID 共用协议槽时，TS 读取只接受渠道 binding；Ticket 25 会话以合成 PG 复现并修复，
  保持原 turn/input binding 不改写。相关 assistant-discussion/reply-source-guards 18/18。
- 修复后重启同一 `npm run dev` 实例，旧助手会话实际显示 3 种可编辑候选和
  “聊天 50 条 · 本次输入 1 条”；没有把修复测试代替真实 App 证据。

## 取消、退出与删除

- 生成中 Esc 或隐藏小窗不会取消物理调用；生成中点击“新开助手会话”只切换目录，旧请求随后
  以 failed 收尾，物理回执仍记为成功（`5c6cdedd-d32e-4b5f-915b-dd84fae532e7`），没有提交候选。
- 生成中正常退出 App 后，turn `dc5772fb-f345-4c29-90d0-93753a4c8a1f` 持久为 failed；
  物理回执 `380769aa-feac-47cf-bf43-a487f275717a` 成功但未产生可提交候选。重启后状态仍在。
- 在 `cca335e4` 上重新启动同一资料目录，确认 `cloudy` 后发起生成。真实页面显示
  “正在生成。”与“停止本次生成”；点击后显示“正在停止本次生成…”，最终显示
  “本次生成已由你停止。”和“本次生成已停止，没有保存候选。”。脱敏状态补丁依次为
  `queued → generating → stopping → cancelled → idle`。
- 停止 jobs 的 turn `88e65711-0d21-4cd6-934b-2e3de6909937` 在 PostgreSQL 中为
  `failed/user_cancelled`，其回复候选计数为 0；旧候选仍明确标为“上一组”，没有冒充本次结果。
- 第一次尝试旧 HEAD 时，prepare 回执与停止按钮均正常，但点击请求到达 Python 兼容路由后被
  `assistant_session_request_invalid` 拒绝；该 RED 已由 `cca335e4` 的真实 HTTP 路由测试覆盖。
- 来源删除已由 Ticket 17 在真实 App 验收：数据库删除终态、五步 `verify_not_retrievable`
  成功，重启后 UI 自动显示文件名清除与不可检索校验。
- 全程没有发送微信消息；没有保存或上传视觉帧。主动停止已闭合；Ticket 25 继续因真实模型
  失败率、费用、盲评与非回复域质量矩阵保持 claimed。
