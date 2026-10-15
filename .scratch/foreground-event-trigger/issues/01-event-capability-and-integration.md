# 事件优先触发前台名称识别

State: claimed
Triage: ready-for-agent
Type: task
Blocked by: 无

规格：[前台联系人变化触发识别](../spec.md)。

## 验收条件

- [ ] 有限实机核验当前微信与权限是否支持可用 AX 通知，保留匿名结果。
- [ ] 根据证据选定并接入事件来源，事件触发不再等待固定正常间隔。
- [ ] 使用既有公共接口验证单轮、合并、退避、代际和停止，不改联系人确认事实。
- [ ] 正式包实测名称正确、提示稳定及切换到显示的延迟；记录资源与清理情况。

## Comments

- 已创建仅元数据开发诊断 `native/macos/Diagnostics/SessionEventCapabilities.swift` 和有限入口 `desktop/tests/native-session-events.spec.ts`。这不修改正式 App，也不能证明事件触发已实现。
- Swift 编译、独立 ad-hoc 签名严格检查、TypeScript 检查及差异空白检查通过，尚未运行新诊断。诊断进程的辅助功能准入不等于正式 App 的准入；无通知也不能在缺失手动切换记录时解释为微信不支持。
- 双轴评审：Spec 0；Standards 曾发现窗口 AX 超时未继承应用对象设置，已逐对象设置 50ms、登记/注销各设 2 秒预算并复核为 0。结束定时器扣除准备耗时，外层仅终止本次子进程作有限收尾兜底。
