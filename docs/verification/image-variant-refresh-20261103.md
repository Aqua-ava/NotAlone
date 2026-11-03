# 图片资源角色与缩略图复查验收（2026-11-03）

按 [ADR-155](../../architecture/adr/155-image-variant-display-and-thumbnail-refresh.md)分别展示资源角色与原图证明，并允许已保存缩略图在主图到达后更新。

## 实现

- 聊天投影新增安全枚举 `image_variant`，桌面桥接为 `imageVariant`。有依据的主图无原图证明时显示“主图”；缩略图显示“缩略图”，既有已认证原图继续显示“原图”。旧 unknown 无角色依据仍显示“图片版本未确认”，不猜测回填。
- 图片同步仅对已有合法缩略图安排分钟复查；每消息每 60 秒时间窗持久去重。主图和旧未知版本不轮询，普通历史失败保持原同步去重规则。
- 复查仍为缩略图或缺少主图依据时保留原 current 文件，新临时文件沿媒体替换删除链清理；读取失败亦保留原副本。合法主图沿正常发布、来源证明与受管文件替换流程更新。
- 每轮核对有效联系人目录和读取总开关；停读、退出取消调度，已清除、隔离或来源受限的图片不能自动恢复。复查不点击微信、不驱动下载、不触发记忆或外部模型。

## 自动验证

以下范围存在重叠，不合并计数。

| 范围 | 命令与结果 |
| --- | --- |
| 后台媒体与图片相关模块 | `node --test test/sqlite-image-sync.test.mjs test/sqlite-media.test.mjs test/sqlite-media-deletion.test.mjs test/sqlite-image-quality-evidence.test.mjs test/sqlite-media-host.test.mjs test/sqlite-original-image.test.mjs`：79 项通过 |
| 资源角色及聊天 HTTP 投影 | `node --test test/sqlite-image-quality-evidence.test.mjs test/sqlite-history-http.test.mjs test/sqlite-original-image.test.mjs`：43 项通过 |
| 自动复查 | 上述 `sqlite-image-sync.test.mjs`：13 项通过；捕获旧实现不更新的红→绿，覆盖后续主图、无改善、失败、同窗及协调器重建去重、停读、退出和清除保护 |
| 桌面桥与 Chrome 页面 | `node --test tests/history-image-message.test.mjs tests/contacts-history-view.test.mjs`：11 项通过；四种标签及旧记录兼容均覆盖 |
| 后台与桌面类型 | 两目录分别执行 `pnpm run typecheck`：通过 |
| 独立核对 | 对自动复查及资源角色投影分别审查，未发现阻断问题；核对删除链、来源复验及桥接矛盾状态拒绝 |

定时器合成用例使用 Node 模拟时间推进，来源与媒体适配器使用隔离合成资料；这证明调度、持久去重及文件生命周期，不替代真实微信下载行为的验收。

## 开发 App 分项验收

- 仅使用 `pnpm run dev`，确认热更新监督器及 `--notalone-dev` 宿主存活。沿用现有手动后台配置；没有开启全量自动同步或记忆处理。
- 沿正常已授权单消息媒体 HTTP 提取入口重读用户指定图片。旧副本为 96 × 210 缩略图，已更新为 1280 × 2774 主图（1,115,021 字节），与此前只读复查的完整内容摘要一致；无原图证明，保留 unknown 原图资格及 main 资源角色。
- 同联系人其余 5 张文件、内容摘要与原有原图证明保持，当前文件总数仍为 6，替换清理完成。没有处理其他联系人的图片。
- Computer Use 在真实 App 选择指定联系人、加载较早记录并滚动查看，确认实际图片预览及“主图”标签；既有“原图”标签仍正常。私人截图、联系人和图片未写入仓库。
- `sync_capture`、`capture_record`、`model_call`、`model_operation` 计数均未增长；SQLite `quick_check` 为 ok，外键问题为 0。未发送外部消息。

实际 App 仍保持手动后台模式，因此本机分项验收覆盖正常提取后的副本与显示更新；分钟自动复查、重建去重和停止边界由上述合成回归覆盖，未宣称完成真实自动后台模式的定时验收。

## 运行与清理

核验无监听进程后清理当前项目遗留开发 socket；开发监督器随后以独立后台进程启动，最终状态正常。保留当前热更新实例供查看，未制作发布包。开发目录前后约 3.8 MiB，现有原生只读器和媒体验证器约 52 KiB／384 KiB，无本轮闲置构建副本；卷可用空间从约 92 GiB 至 90 GiB，业务数据库及其 WAL 未作缓存清理。
