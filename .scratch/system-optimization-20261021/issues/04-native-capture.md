# 原生定位开销与旧诊断入口

Triage: ready-for-agent
State: claimed
Blocked by: None

## 来源

[统一规格](../spec.md)、统一规格中的两份审计报告及合成复现脚本。

## 职责边界

全帧亮度计算按需化、退役可达的旧聊天正文OCR诊断入口；职责仅native/macos、对应文档/测试，必要时只更新相关ADR明确实现边界，不涉及Desktop发布门禁。

## 完成条件

保留同一像素/颜色/透明度/失败回退语义；只做前台可见唯一微信窗口内存布局和自动定位名称区域OCR；不持久化/上传原图。局部合成基准与RSS区别，不能拿局部速度冒充真实识别延迟；不得运行正文OCR来证明旧入口。实际微信验收交05统一协调。

必须先核当前main、读对应架构与仓库工程规范；先复现再实现，完成目标而非只写计划。每个聊天开始先调用create_goal，不设预算；本issue改claimed，实际完成并写Answer后改resolved。结果写本目录../04-native-capture-result.md。不直接修改共享root产品代码，不push、不打包、不迁移业务库、不发外部消息。

## Comments

