# 票21 锁定DSH与适配边界

- 版本：`@deepseek-ai/dsh@0.2.1-rc.2`，官方commit `687f282e8625c6b8d11ff58211a90524be2e4317`。当前官方源码是主协调恢复的codeload归档，没有.git；归档摘要与恢复来源见 `../runtime-validation/recovery-20261024.md`，不将目录伪称为可验git checkout。
- 官方文档：[app-boot README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/README.md)，Use this package/Profiles明确产品由官方launcher和profile运行；普通功能不是独立自建bin。
- 官方源码：[profile-boot.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/profile-boot.ts#L283)，283–345提供树dispose、关闭与appReady；本票资源由现有薄插件登记关闭，不能把不合作Promise误称强制取消成功。
- 公开宿主服务：[cmdline/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/cmdline/src/index.ts#L32)，appExit/appReady为启动与退出服务。现有host-plugin沿此入口，前台定位不建立DSH模型session或Tool。
- 已有裁剪实例：`backend-ts/profile/host.patch.yml`显式列出通用官方插件与notalone-host，未新增插件、日志上报、Shell或OCR模型；本票继续复用，不改核心/profile/package/lock。
- 结论：名称匹配、CLI元数据投影、原PG绑定核验及原生JSONL协议属于普通业务TS，**不涉及直接DSH接口**。唯一运行交互是薄插件启动/HTTP路由/停止排空；需实际官方profile验证，文档阅读本身不算运行通过。
- 官方既有运行证据：`../runtime-validation/progress.md`已记录14/14运行合同与配置闭包；这是02基线，不能替代21的功能验收。21的官方宿主及桌面控制器合成测试已通过，见progress.md；实际App仍未完成，不能将前两者替代实操。
