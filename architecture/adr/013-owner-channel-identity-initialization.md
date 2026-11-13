# ADR-013：Owner 渠道身份与首次导入初始化

> 后续补充：[ADR-095](095-first-wechat-connection-and-account-grant.md)增加已配置工具账号的首次连接与明确范围授权，不再要求 App 先导入历史才能建立本人渠道身份；原导入一致性与内部身份分离保持。

> 2026-10-21 设计审查：App 本人初始化时机由 [ADR-021](021-source-distribution-and-first-run-setup.md)提前到首启，并由 [ADR-061](061-standalone-local-app-onboarding-and-updates.md)承接本机设置；下文首次导入初始化保留为 CLI 兼容路径，不是 App 首启唯一入口。本人／联系人渠道身份分离与一致性核验保持。

> 状态：已采纳
> 决策日期：2026-08-23

## 背景

导入文件可以确定本人消息中的微信 `sender_wxid`，但这个外部标识不能直接成为 NotAlone 的 `owner_id`。如果首次导入要求用户手工填写内部 UUID，实际流程容易卡住；如果每次直接用文件身份猜 owner，又会把来源文件变成数据归属凭证。

## 决策

1. `owner_id` 是 NotAlone 生成的稳定内部身份；微信 `sender_wxid` 保存为独立的 `owner_channel_identity.external_id`。
2. v1 每个 owner/channel 只允许一个 active 渠道身份；历史身份可以标记 `revoked`，未来换号必须显式重新绑定。
3. 首次导入或明确恢复时，用户必须传递 `--initialize-owner`。事务内按以下顺序处理：识别本人渠道身份、复用已确认 owner 或生成新的 owner、保存 owner 渠道身份、确认联系人、写入来源和消息。
4. 初始化成功后，生成的 `owner_id` 写入受控本地 `.env`；进程环境变量优先，`.env` 不进入 Git。后续导入使用受控运行身份，并将文件中的本人 `sender_wxid` 仅作为一致性校验。
5. 缺少本人消息、出现多个本人 `sender_wxid`、与 active owner 身份不一致或已绑定到其他 owner 时，整份导入失败；不得按出现频率猜测或静默改绑。
6. owner 和联系人各自拥有内部 ID、渠道身份和可变展示名称。来源删除不删除 owner、联系人或渠道身份；联系人删除才级联清理其关系资料。

## 后果

- 数据库新增 `owner_channel_identity`，与联系人 `channel_identity` 分开，避免把 owner 和联系人混成一个渠道对象。
- 导入 CLI 多一个一次性显式初始化动作，但用户不需要手工生成或填写 UUID。
- 重新绑定、跨设备恢复和多账号支持仍需要独立的用户流程；v1 不自动推断这些情况。
