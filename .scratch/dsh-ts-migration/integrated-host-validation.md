# 09／19／21共享官方宿主整合验证

2026-10-24，主目标在原范围内整合已交接成果；相关子会话的目标状态保持原值。

- 基线 `ee2b0a33`，归档已提交backend/backend-ts/desktop，仅覆盖8个共享源文件与直接测试/夹具；其他05在途生成、模型模块未进入本轮源码树。覆盖清单及前后摘要见 `integrated-host-source-hashes.json`。
- DSH锁定 `0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`；源码核对 `packages/boot/cmdline/src/index.ts:45–52` 的成功启动onReady及取消监听合同。继续官方profile与现有退出机制，不修改DSH核心。
- 命令：固定Python运行 `verify-integrated-host.py --smoke`、`--foreground-revoke`、最后不带参数；每次运行固定Node、关闭草案overlay，测试后对整个隔离树执行 `tsc --noEmit`，均有时限。
- 阶梯结果：管理冒烟1/1；断连撤销1/1；最终三模块13/13、零跳过（38.782秒），严格类型检查通过。含记忆偏好5、前台定位4、增量同步4。
- 验证认证与同名隔离、原UUID/大修订、纠错和删除、唯一管理写者、排空取消回滚、结构失败关闭、TS增量/Python历史唯一责任、内部事件只携身份、关闭/撤销/退出后迟到消息拒绝。
- 独立Spec发现的P1已关闭：Python完整撤销回执后发生的客户端断连不再被当作未知transport而永久停止前台；仍保留增量停读。实际官方HTTP旧用例已通过。Standards及修复后Spec均无待整改finding。
- 首轮前台4项失败并非最终通过结果。隔离诊断确认新合成CLI路径首次直接exec超过250ms；只改测试夹具为等价shell并在启动宿主前做一次5秒上限的status准备，动态名单与运行时250ms不变。固定副本单变量0/4→4/4；未推断底层系统机制。指标见 `integrated-host-diagnostics.json`。
- 独立Python归档树只叠加app/command/管理gate，运行route_dispatch_golden、runtime_shutdown、contact_context_handoff、foreground_location_handoff四模块，36/36通过（8.512秒）；合成错误路径日志为预期断言。
- 数据影响：仅合成隔离PG、CLI/探针、临时源码和本机官方runtime；无真实模型、私人资料或外部消息。各测试清理自有资源，开发App状态另核验stopped/pids=[]。
- 范围限制：证明当前共享源码与官方HTTP集成；不证明05完整生成或真实微信OCR，也不替代后续切换回退与最终退役。新的实际App检查安排在隔离已提交源码上。
