# 02 — 实现前台选中会话定位器

Type: task
Triage: ready-for-agent
State: open
Blocked by: 01

## What to build

在现有 `macos_sync_probe` 上增加最小前台会话定位结果：微信是否前台、顶部 display name、左侧当前选中会话行的选中状态、最近时间和短预览。只捕获必要区域，不读取整个联系人列表；输出供上层与 CLI `sessions`/`resolve-chat` 候选比对。

## Acceptance criteria

- [ ] 微信不在前台、同步关闭或无法确定选中行时返回不可用，不产生消息事件。
- [ ] display name 与选中行元数据按同一帧或同一稳定窗口结果返回。
- [ ] 重名时可返回多个候选，不静默选择。
- [ ] 视觉指纹只作为元数据匹配失败后的备用；默认不保存原始截图。
- [ ] UI/菜单显示当前 display name 和同步状态，不显示其他会话正文。

## Verification

- 合成窗口测试标题、选中行、时间/预览裁剪和区域变化。
- 经授权的本地微信测试切换两个联系人、标题暂时不可读和非前台状态。

## Out of scope

- 不绑定 `contact_id`，不读取 CLI 消息正文，不启动 tail。
- 不自动点击、切换或滚动微信。
