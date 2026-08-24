# 04 — 真实微信 --follow 只读冒烟（人工）

Type: task

**Triage:** ready-for-human
**State:** open

**What to build:** 在真实微信环境中确认 `tail --follow` 长进程稳定：消息到达近实时、不丢不重，切换与切回时水位正确推进，流进程异常后能恢复。这是一次只读验证冒烟；通过之前，一次性轮询仍是同步主路径，事件驱动不替换轮询。

**Blocked by:** 03（CLI 适配器 --follow 流式读取与事件驱动同步）

- [ ] 真实微信前台下，follow 流持续收到新消息，无丢失、无重复入库。
- [ ] 联系人切换与切回时水位连续，补读行为符合 `cli_catchup` 语义。
- [ ] 流进程异常终止后的退避重启与水位恢复路径被实测。
- [ ] 微信退出前台、同步关闭等边界下的停读行为符合失败关闭语义。
- [ ] 冒烟结果与剩余风险记录在本票 Answer。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。
- 冒烟沿用仓库既有冒烟记录惯例（参照 `.scratch/local-wechat-cli-observation/smoke/`）。
