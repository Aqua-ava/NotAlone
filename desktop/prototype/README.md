# 管理后台与输入小窗历史原型

这是仅含合成状态的独立 HTML 原型，用于追溯双窗口布局比较；当前产品是 Electron／React，使用[桌面开发入口](../README.md#日常开发热更新)。原型中的先确认方向、背景默认关闭、模拟文件导入等旧交互不约束当前设计，当前回复合同见[回复生成](../../architecture/current/reply-generation.md)。

## 要回答的问题

原型保留独立管理后台，以及 A 横向候选栏、B 纵向候选窗、C 单行工具条三种小窗布局。它记录当时比较方式，不表示当前仍待选择产品架构。完整阶段过程和 2026-10-08 视觉验证见[原型历史](../../docs/history/desktop-development-history.md#界面原型整理前记录)。

## 启动与预览

仅在明确查看历史原型时，从仓库根目录启动：

```bash
node desktop/prototype/start.mjs
```

也可在 `desktop/` 使用 `pnpm run prototype:replies`。这是常驻本机服务，Agent 启动时按工程工作流放后台并在结束后清理自有进程。它只监听 `127.0.0.1`，默认端口 4176，可通过 `NOTALONE_PROTOTYPE_PORT` 指定；`NODE_ENV=production` 拒绝启动。

- [管理后台](http://127.0.0.1:4176/prototype/notalone-windows/?surface=manager)
- [小窗 A](http://127.0.0.1:4176/prototype/notalone-windows/?surface=ime&variant=A)
- [小窗 B](http://127.0.0.1:4176/prototype/notalone-windows/?surface=ime&variant=B)
- [小窗 C](http://127.0.0.1:4176/prototype/notalone-windows/?surface=ime&variant=C)

## 体验路径

分别打开后台和小窗，查看合成页面、示意候选、编辑、模拟复制和布局切换。左右键只在非编辑状态切换布局；另开页面各自持有独立合成状态，不验证产品双窗口通信。具体旧操作顺序见历史记录。

## 已确认的边界

现行产品约束统一见[架构入口](../../architecture/README.md)。原型的合成绑定、导入、生成、同步、退出和权限状态不能证明当前产品实现或授权。

## 数据与能力边界

资料只存在浏览器内存，不调用模型、真实后端、数据库或微信；“复制”只更新内存字段，不写系统剪贴板。没有全局快捷键、真实置顶、系统权限或操作系统输入法接线。示意生成仅演示原文及分句，不能评价模型质量。

## 保存与验证

源码语法可分别用 `node --check desktop/prototype/app.js` 和 `node --check desktop/prototype/start.mjs` 检查；页面需实际浏览器核验。旧截图、分支与阶段结果保留历史来历，不作为当前 Electron UI 验收。

### 品牌视觉调整（2026-10-08）

旧视觉调整记录见[原型历史](../../docs/history/desktop-development-history.md#界面原型整理前记录)。服务仍通过受限静态路由读取仓库品牌图片，未接入图片生成或上传能力。
