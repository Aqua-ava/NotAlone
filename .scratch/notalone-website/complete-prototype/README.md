# 官网完整交互原型

本原型回答：既定水彩拼贴视觉能否承载完整的项目介绍和一次可理解的回复体验？按用户要求只制作一版完整页面，等待视觉反馈，不重新展开风格分支。

## 启动

在仓库根目录运行：

```bash
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate NotAlone
python -m http.server 4173 --bind 127.0.0.1 --directory .scratch/notalone-website/complete-prototype
```

打开 http://127.0.0.1:4173 。也可直接打开 index.html；浏览器禁止剪贴板时会选中文字，提示手动复制。

## 内容与边界

- 首屏、两个可切换虚构场景、候选选择、依据展开、文本编辑、复制、理念及项目页尾。
- 沿用现有 logo-m3.png 的水彩拼贴图片；独立复制为 assets/logo.png，旧原型不变。
- 不调用模型、聊天接口或分析服务；编辑只留在页面内存，刷新即消失；只有主动复制会写入剪贴板。
- 本次保存在本地原型分支 codex/website-preview，未经部署；视觉取舍等待用户反馈。

## 验证记录（2026-09-15）

- `node --check .scratch/notalone-website/complete-prototype/app.js` 通过。
- 本地 HTTP 服务成功启动，浏览器确认图片、样式和脚本正常加载。
- 浏览器实测两个场景切换、候选切换、依据展开、编辑和复制，复制后显示成功状态。
- 390 × 844 手机视口实看对话、候选及编辑区，布局改为单列；检查后恢复默认视口。
- 初次直接 conda activate 因 shell 未初始化失败；加载 conda.sh 后启动成功。
- 当前为预设数据原型，不证明真实模型或微信集成可用；尚未进行跨浏览器兼容性与正式发布验收。

## 两种用法修订（2026-09-15）

按用户确认，将原先两个聊天场景改为「帮我回复」与「帮我改写」：前者从表达方向出发，后者展示原句、可选改写要求和改写后的候选。两者使用同一虚构联系人，突出输入方式的区别。

验证：`node --check .scratch/notalone-website/complete-prototype/app.js`、`git diff --check` 通过；浏览器刷新后确认两种模式显示不同输入，改写候选选择更新编辑区，依据展开显示原句与改写要求。仍为预设合成演示，无新增数据处理或外部连接。
