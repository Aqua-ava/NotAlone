# v9 实际点击置前与有界按键的单场对照

2026-10-16。前次[Tab30场](../foreground-contact-follow/real-cli-visual-v9-tab30-result-20261016.md)在微信25秒门失败，12次正式观察均完整paused且采集/OCR为0；未进入helper或发Tab。记录不含细分reason，不能解释为名称不匹配。事后微信显示另一会话，也不能倒填原场原因。

本次只修正现场操作前提：沿既有单联系人范围选择原验收条目，使用Computer Use坐标点击可见窗口并在同call内保持一次Tab20，尝试提供足够长的实际前台观察机会；它与既有AX Raise/菜单操作分开记录，不事先宣称已保持原生前台或已证明单一根因。

1. 原场已清理后，Root按现有授权另行明确启动唯一新8分钟/max1场。仍用冻结v9及[原计划](real-cli-visual-v9-tab30-natural-tail-plan-20261016.md)六份源摘要、原单A immutable字段、新鲜范围/默认目录metadata/随机库/依赖归属账；incoming=false、long_running=false，无模型。未通过准备或资源归属检查即停。
2. Root先用既有验收记录和当前唯一验收条目核对操作目标，再用CUA选择该条目。仅以已批准测试文本预览定位UI，不把预览当联系人身份认证或建立新绑定；真实CLI始终受原唯一locator约束。若目标无法唯一对应，不启动。只看必要窗口/名称，不处理私人正文，截图不入库。
3. 原微信stage就绪后核同runId/PID/lease/截止，按原协议写wechat.trigger。紧接单次CUA对刚观察的微信安全标题区域作坐标点击，读取AX，再`pressKey('Tab', {durationMs:20000})`，该次`timeout_ms:60000`。不按Enter/Space，不输入消息、不发送。调用结束先核原PID与stage，不访问已退出App。原25秒门、正式recognized完整计数全部不改；Tab完成或AX本身不签前台通过。
4. 仅微信原门实际通过才沿原计划：helper waiting固定CLI行边界，等边界后唯一新自然tail完整started(正PID)→同PIDfinished0→accepted，记首次本地观察t0；约t0+45秒Root核guard后写helper.trigger并同call菜单/AX/Tab30，timeout_ms60000。t0不是CLI事件时刻；没有新tail或余时不足即停止。helper70秒、首次原生focus单固定、边界后任何新正式probe即失败、新鲜tail及末次focus均不改。
5. Finder及退出仍沿原场协议；任何阶段失败保留原判，不自动重开。精确核所有自有PID/随机库/userData/fixture/租约/pair及空目录，正常退出与失败fixture回收分账，默认metadata/ASAR/签名复核。无新权限、联系人授权、来信、外部发送或远端操作。

本计划仅文档准备，尚未为本场创建scope、恢复pair、取得租约或启动App；独立两轴审查通过后才由Root明确启动。不追认前次Tab效果，不以将来的通过覆盖旧失败；仍没有联系人身份或持续来信验收信用。
