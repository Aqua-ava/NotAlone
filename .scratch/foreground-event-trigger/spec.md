# 前台联系人变化触发识别

用户已确认正式 App 名称识别准确、提示稳定，仍认为切换后的等待过长；已授权选择流程并推进。当前正常轮次结束后固定等 2 秒，真实旧场两次采集间隔约 2.5 秒，不能将其称为用户切换延迟。

采用 `ask-matt → grill-with-docs → implement/TDD → code-review`。联系人身份与 OCR 正确性已有边界，先做最小原生能力验证，再决定事件来源；不重做联系人、草稿或生成验收。

## 目标与边界

- 变化提示到达后优先触发现有新观察，取消空等；原有单轮在途、认证 HTTP、质量与唯一已有绑定核验保留。
- 切回微信与微信内切换会话分开验证，AX 注册成功不等于联系人切换时会发事件。
- 不读取聊天正文、AX 联系人文本或其他 App 内容；帧仅端侧内存，OCR 仍仅顶部名称。
- 同一连接只有一个事件来源。事件仅提示变化，不能携带或自行确认联系人身份；失焦、停用、断连、退出与旧代际丢弃仍有效。
- 保留有限周期复验以维持现有五秒名称时效；不能通过刷新旧时间戳伪造新观察。
- 若需持续标题区域画面比较，明确修订 ADR-050 与 ADR-053 的采集/调度约定，并实测资源开销。未核验前不宣称低耗或亚秒响应。

## 当前已确定与待核验

- 已确定：NSWorkspace 前台激活通知只解决回到微信，不能代替微信内部切换事件。
- 待实机核验：现有权限下 AX 是否可用、当前微信是否发出标题/选择/焦点事件，以及它们是否覆盖连续切换。
- 第一动作：受限 `test:app` 执行 90 秒仅元数据通知诊断，主 Agent 独占一轮、最多启动 1 次；不弹权限申请、不保存身份。若 AX 不可用，选择现有录屏权限下的标题区域变化检测，不把缺失通知当成功。

## 验证接口

沿用已有 `/api/sync/foreground/observe` 与正式 ForegroundController 的公共状态/联系人接口，验证事件可以提前触发、在途仅合并一次、迟到结果不能覆盖新代际、真实失败保留退避、停止后零新观察。原生通知适配器只用合成信号/图像验证纯处理；真实通知覆盖率与端到端延迟必须来自有限实际场次。

## 一手资料

- https://developer.apple.com/documentation/applicationservices/1462089-axobserveraddnotification
- https://developer.apple.com/documentation/appkit/nsworkspace/didactivateapplicationnotification
- https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo/dirtyrects

Context7 未提供可调用工具，已核对 Apple 官方文档和本机 SDK；API 存在不证明微信提供对应通知。
