# 修复包 Computer Use 实机验收

日期：2026-10-15（台北时间）。结论：顶部提示条修复及单联系人群聊往返通过；移动与缩放后的自动恢复未通过，完整18/06保持未完成。

## 实际范围

Agent 通过 Computer Use 直接操作微信与正式 NotAlone 修复包，没有要求用户代做操作。自动化 runner 只负责隔离夹具、正式包启动、状态测量及收尾；界面交互使用 `cua_repl`。

使用既有 `desktop/artifacts/header-layout-fix-20261015-v1/NotAlone-darwin-arm64/NotAlone.app`，没有重建或修改产品代码。启动1次，用例运行约12.4分钟，约17:29至17:42结束。独立userData、随机测试数据库、合成CLI会话与正文、真实原生顶部OCR；只配置测试联系人A。本轮不能认证真实CLI正文同步、双联系人切换、候选归属或模型质量。

运行时沿用工作区已有观测夹具，未提交这些既有未提交文件。包内资源摘要与修复票一致：

- ASAR：`0fd757a2e6ba0301ba9170ce5f1938e3d9742bfe774d5ed4d56f123a5d1ba427`
- 探针：`0cc44130a6f6be42c284587402db4d12139e4127a0167bd8c6fe4dac2294d7ae`
- 核心库：`e0ad12c46f1a213434b88de05b32d3e91b5efd455f6f18611474fc929a3f0c44`

## 操作与结果

| 实际操作 | 观察结果 | 判定 |
| --- | --- | --- |
| 切到带单行顶部提示条和人数尾缀的群聊 | 正式状态显示群聊暂停；群名不进入预览；新生成被阻止 | 通过 |
| 返回测试私聊 | 顶部名称与屏幕一致，置信度100%；首次因之前窗口过渡失败保留人工门 | OCR通过，人工门未被静默解除 |
| 在正式助手明确确认联系人，再返回微信 | 正式状态自动匹配测试联系人A，`verified-binding`、选中与确认归属一致 | 通过 |
| 输入15字合成草稿，切群聊并打开助手 | 草稿逐字保留；联系人选择器及生成按钮禁用，无人工绕过入口 | 通过 |
| 返回同一已绑定私聊 | 无额外确认即恢复已验证绑定及生成资格，草稿仍与输入一致 | 通过 |
| 进入助手、隐藏助手并返回微信 | 助手获焦时暂停新定位，返回微信后恢复识别 | 通过 |
| 微信“窗口 → 移动与调整大小 → 右侧”，随后恢复上一个大小 | 组合移动/缩放后进入unavailable，再进入manual-required；仍读出100%名称，未自动恢复，草稿保留 | 未通过；未分别隔离移动与缩放 |
| 结束前恢复其他应用可见性 | 又观察到探针超时提示，生成继续被阻止 | 失败记录，不推断根因 |

原生控制的坐标点击返回`AXError.notImplemented`，改用微信原生菜单和快捷键完成会话切换。普通Raise/前置窗口命令一度未改变系统前台分类；通过全屏往返确认激活，再改用微信“隐藏其他”稳定取得前台。全屏过渡中出现窗口歧义，之后仍需明确人工确认。这些准备阶段与17:40的组合移动/缩放失败分开记录。

17:40:01.857已处于confirmed且合成草稿一致；17:40:24.123进入unavailable；17:40:28.681进入manual-required。同期17:40:23.723与17:40:27.986开始的原生调用均返回recognized，约462/468ms，各1帧、1次顶部OCR。由此只能确认恢复门未自动解除，不能将根因直接归到OCR、窗口歧义或超时。后续见[待分诊任务](issues/02-window-change-manual-gate.md)。

## 证据与验证

实际命令：先激活Conda `NotAlone`，在desktop运行`node scripts/test-app.mjs --interactive --coordinator cua-acceptance --from <本轮开始ISO时间> --until <20分钟截止ISO时间> --max-launches 1 -- tests/continuous-contact-follow-acceptance.spec.ts --output artifacts/cua-header-live-20261015`。本轮私有临时目录经`NOTALONE_AUTOMATIC_CONTROL_DIRECTORY`提供，开关为`NOTALONE_CONTINUOUS_APP_ACCEPTANCE=1`、`NOTALONE_CONTINUOUS_VISUAL_ACCEPTANCE=1`、`NOTALONE_CONTINUOUS_MANUAL_ACCEPTANCE=1`，`NOTALONE_TEST_APP_EXECUTABLE`指向上述包。

用例1/1通过只表示启动、监控、正常退出及清理生命周期通过，不代表全部产品检查通过。Computer Use逐项记录6项符合、2项有问题，A/B与结果隔离未验证；记录者为Agent，不冒充用户体验反馈。

匿名报告位于本地忽略目录`desktop/artifacts/cua-header-live-20261015/`，未提交原始产物。状态更新359次、已验证绑定更新38次；1243份定时样本中93份处于confirmed且A归属一致，其中49份同时具有完全一致的合成草稿。定时样本与状态更新不是独立场景次数。

260次原生调用中，90次recognized、163次paused、5次native-failed、2次unknown。recognized调用约418–746ms，中位约470ms；这不是完整切换延迟。界面失败分类累计更新包含窗口歧义7次、探针超时3次、需人工确认96次、观察不可用4次；更新计数不是独立故障次数。

## 数据与收尾

产品仅在本机内存采集及OCR顶部名称，没有真实CLI正文读取、外部模型调用或消息发送。Computer Use为验收查看实际窗口；未另存或提交截图、联系人名称、私人正文、凭据和可识别夹具。

App正常退出，认证HTTP停读；隔离后端exit0，随机测试库删除确认，未确认资源为空。自有App PID不存在、userData已删除、runner退出0、租约absent。已恢复微信原窗口大小及测试私聊，执行“显示全部”恢复应用可见性，关闭自有访达定位窗口；本轮私有协调目录随后精确清理。既有工作区改动保留。

本次未通过项需要诊断和修复；原18/06、真实CLI同步、双联系人及生成结果隔离均未签收。
