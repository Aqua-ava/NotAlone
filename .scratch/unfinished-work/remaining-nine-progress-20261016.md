# 本轮未完成任务推进记录

日期：2026-10-16。按用户要求不推进 `memory-skill-evolution` 的15张任务；其余原9张逐项处理。当前任务文件扫描共230张：208张resolved、7张claimed，以及上述排除的15张open。状态以各原票为准；resolved也可能包含历史替代或不采用结论，不能据数量推导产品能力。

| 原任务 | 本轮状态及证据 | 下一项 |
| --- | --- | --- |
| [前台跟随06组合验收](../foreground-contact-follow/issues/06-combined-app-acceptance.md) | 已resolved；[单联系人实机及组合结果](../foreground-contact-follow/acceptance-06-final-20261015.md) | 本票范围完成，后续新包分项不倒填旧包 |
| [群聊暂停人工验收01](../foreground-group-manual-acceptance/issues/01-group-pause-and-live-checklist.md) | 已resolved；实际群聊暂停与返回私聊核验已记录 | 本票范围完成 |
| [事件优先触发01](../foreground-event-trigger/issues/01-event-capability-and-integration.md) | claimed；独立源与正式探针并行完整55秒通过；[App内采样](../foreground-event-trigger/app-source-observation-20261016.md)不足以认证续租或名称显示 | 补最小生命周期观测，实测完整租期、下一轮启动与事件触发 |
| [前台定位18](../mac-desktop-app/issues/18-foreground-locator.md) | claimed；单联系人绑定/暂停恢复已有实机；[真实CLI与正式视觉独立场](../foreground-contact-follow/real-cli-visual-20261015.md)通过 | 当前包独立启动权限和持续源边界 |
| [本机交付20](../mac-desktop-app/issues/20-mac-app-delivery.md) | claimed；当前签名包Finder启动、真实选择/导入等分项已有证据；[真实DeepSeek合成App冒烟](../mac-desktop-app/reply-model-smoke-result-20261016.md)1／1通过，模型AC完成；[快捷键复验](../mac-desktop-app/native-shortcut-current-20261016.md)未观察到显示 | 独立启动权限、系统快捷键 |
| [真实微信follow04](../native-app-backend/issues/04-real-wechat-follow-smoke.md) | claimed；单联系人有界读取、退出停读及视觉独立性已有证据 | 新包重开补齐；双联系人和真实来信依用户决定保留未验证 |
| [核心事实保留01](../memory-core-claim-retention/issues/01-diagnose-fix-and-replay.md) | claimed；当前公开部分基线完成，核心B01/B02未运行 | 当前结果不能代签核心保留目标，旧真实/留出不读不改 |
| [指代消解07](../memory-extraction-accuracy/issues/07-reference-resolution.md) | claimed；当前基线13/21窗，其中指代主集13/16窗；已完成子集完整契约9/15条必需主张 | 保留歧义、转述及替代解释失败，15条主张不改算15个用例，原质量门未满足 |
| [按维度放行03](../memory-accuracy-next/issues/03-per-dimension-rollout.md) | claimed；结构和合取门已有实现，默认放行表仍为空 | 真实质量与typed依据分别验收，不用pending或V支持补签放行 |

本轮官方DeepSeek公开基线实际25次HTTP、零重试，13窗完成、8窗未运行；A13整组去向合同触发停止，剩余17次永久关闭。[完整结果](../grounded-evaluation/deepseek-public21-result-20261015.md)区分内容事实错误与整组auto/pending合同，不覆盖原Gold、旧失败或分母。未使用ECNU，没有上传真实聊天或放开自动采纳。

数据边界：桌面模型新场仅使用合成草稿，实际1次官方HTTP200且已独立闭账；真实CLI只在既有单联系人范围和新鲜有限基线内运行。截图/正文/联系人身份及凭据不提交；没有外部聊天发送或远端Git操作。用户进入本轮前已有dirty文件保留，本地提交只收本任务变更。具体命令、原失败、资源清理和两轴审查见各证据报告。
