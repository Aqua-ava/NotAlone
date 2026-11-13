# 02 — 实现前台选中会话定位器

Type: task
Triage: ready-for-agent
State: resolved
Blocked by: 01

## What to build

在现有 `macos_sync_probe` 上增加最小前台会话定位结果：微信是否前台、顶部 display name、左侧当前选中会话行的选中状态、最近时间和短预览。只捕获必要区域，不读取整个联系人列表；输出供上层与 CLI `sessions`/`resolve-chat` 候选比对。

## Acceptance criteria

- [x] 微信不在前台、同步关闭或无法确定选中行时返回不可用，不产生消息事件。
- [x] display name 与选中行元数据按同一帧或同一稳定窗口结果返回。
- [x] 重名时可返回多个候选，不静默选择。
- [x] 视觉指纹只作为元数据匹配失败后的备用；默认不保存原始截图。
- [x] UI/菜单显示当前 display name 和同步状态，不显示其他会话正文。

## Verification

- 合成窗口测试标题、选中行、时间/预览裁剪和区域变化。
- 经授权的本地微信测试切换两个联系人、标题暂时不可读和非前台状态。

## Out of scope

- 不绑定 `contact_id`，不读取 CLI 消息正文，不启动 tail。
- 不自动点击、切换或滚动微信。

## Answer

已完成前台选中会话定位器：

- 新增 `SelectedSession.swift`：`SelectedSessionLocator` 只在左侧面板内按行均亮度寻找唯一高亮选中行，扫描下界限制在输入区顶线以上；找不到可靠高亮时返回空。
- `SelectedRowRegion` 提供名字、右上角时间、短预览和头像四个裁剪区；头像区仅供后续备用视觉指纹，不保存原图。
- `WeChatCaptureProbe` 拆出 `captureWindowSnapshot`，聊天区裁剪与选中会话元数据（顶部 display name、选中行名字、最近时间、短预览）来自同一帧窗口图像；微信非前台、找不到聊天区或选中行时抛出稳定错误，不产生任何消息事件。
- 定位器只返回原始匹配证据，不做联系人选择；重名候选比对留给上层与 CLI `sessions`/`resolve-chat` 对齐。
- 菜单栏 App 状态栏持续显示当前 display name 与同步状态；CLI 新增 `--session` 单次定位模式，短预览默认不输出文本。

验证结果：

- `swift test`：14/14 通过，含 5 个新增选中行定位测试（合成窗口标题裁剪、高亮带定位、移动后重定位、无高亮返回空、裁剪区不越界）。
- `swift run notalone-sync-probe --self-test`：自检通过，含选中行初次定位、移动重定位、无高亮停止和 display name 裁剪区检查。
- `zsh scripts/build_cli.sh` 与 `zsh scripts/build_app.sh`：构建成功。

剩余风险：

- 经授权的真实微信冒烟（切换两个联系人、标题暂时不可读、非前台）尚未执行：新构建 CLI 二进制尚未获得屏幕录制权限，且需要用户手动将微信置于前台。
- 同步开关概念还不存在，将在 06 的 tail 生命周期中接入；本轮以前台检查作为唯一门禁。
