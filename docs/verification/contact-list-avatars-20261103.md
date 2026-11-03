# 联系人列表头像验证

## 范围与数据流

- 联系人列表优先显示真实微信头像；不可用时保留名称首字，保持原行尺寸、名称和消息数。可见行才发起读取，显式刷新联系人会重试。
- 使用当前 owner、contact、account、binding 与有效 grant 解析稳定微信身份，不按名称关联；头像读取前、下载前与返回前复验资格。
- 新增独立 `metadata-avatar` 窄命令，只读取所选私聊的 contact 行。原始 HTTP 头像元数据仅对固定微信 CDN 升级到 HTTPS；其他地址拒绝，不改变会话名单或聊天正文协议。
- 下载仅向 `wx.qlogo.cn` / `thirdwx.qlogo.cn`，禁重定向与请求凭据；256 KiB 输入上限、400 万像素上限、10 秒总期限，解码为 96×96 PNG，移除原图附加元数据。
- 地址、原图和缩略图不入业务库，不进入模型；渲染器使用内存 blob，刷新、范围切换及卸载时释放。停读、撤销与关闭取消在途请求；删除复用已有 metadata lifetime 排空机制。

## 自动检查

- Node.js 24.22.1；`pnpm --dir backend-ts run typecheck`、`pnpm --dir desktop run typecheck` 通过。
- `cd backend-ts && node --test test/contact-avatar.test.mjs test/sqlite-contact-binding.test.mjs test/sqlite-contact-close.test.mjs test/wechat-account-metadata.test.mjs`：69/69，通过身份隔离、同名联系人、停读、撤销、来源代次变化、关闭等待、下载限制及实际位图解码检查。
- 桌面头像安全测试 3/3、头像与既有聊天时间线页面测试 3/3 通过，覆盖懒加载、失败兜底、显式刷新、迟到结果和 blob 释放。
- 独立审查未发现阻断项；测试登记检查被并行任务未登记的 `workspace-draft-sqlite-handoff.test.mjs` 阻塞，头像两项已登记。

## 接口依据

复用项目 sharp 0.35.5，按已安装类型及 [输入限制](https://sharp.pixelplumbing.com/api-constructor/)、[缩放](https://sharp.pixelplumbing.com/api-resize/) 核对；网络使用 Node 内置 fetch 与 AbortSignal，不增加依赖。

## 现场验收

- 21:01 左右（台北时间）通过正常停读退出后，将开发配置的微信工具从 `image-quality-20261102-v1` 切换为 `avatar-20261103-v1`，保留原配置和旧制品回滚副本。精确升级 policy 核验新旧全部源码，仅头像两文件及协议分发变化；通过正式 `prepareAliases` 生成来源兼容别名。
- 新 CLI 的账号/头像 Go race 检查 22/22、升级工具检查 29/29 通过。仅构建开发 CLI，没有打包 App。
- Computer Use 已确认真实联系人列表中首屏多张微信头像成功显示，姓名、消息数与卡片尺寸保留；滚动检查发现部分请求超时，未将部分成功写成全部头像通过。私人截图没有落盘或提交。
- 超时诊断：相同真实本机库 285 位联系人，完整目录投影一次 3017ms，精确单联系人身份查询 0.2ms。重复目录投影会阻塞多行头像请求；独立工作树候选改用 `identity.avatarScope`，继续复验完整读取令牌。
- 实际 JsonClient 与本机合成 HTTP 的 9 秒响应基线在 8006ms 被桌面提前中断；隔离候选将头像专用期限改为 15 秒，同一工作负载在 9027ms 正常返回。后台 10 秒期限保持。
- 同步会话另在进行稳定验收，历史固定快照持有共享原生租约时头像可能排队；该吞吐取舍与本次目录重复扫描分别记录。其空会话来源围栏由同步会话处理，不属于头像修复。
- 本轮闲置 Go 工具链及空临时目录已清理，新制品目录由约 275 MiB 降至 16 MiB；保留源码、制品、清单、升级证明及旧回滚版本。

隔离候选的主仓集成和最终桌面复验等待同步验收稳定窗口释放后补充。
