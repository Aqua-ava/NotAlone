# NotAlone 官网

已确认的单页官网，使用原生 HTML、CSS 和 JavaScript，无构建依赖。

## 本地预览

在仓库根目录执行：

```bash
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate NotAlone
python -m http.server 4174 --bind 127.0.0.1 --directory website
```

访问 http://127.0.0.1:4174/ 。部署时仅需提供本目录静态文件；此任务未部署或推送。

## 页面内容

- 水彩拼贴首屏、帮我回复与帮我改写演示。
- 可编辑候选、依据展开及复制功能。
- 单张技术架构图，点击模块显示职责。
- 产品理念与 GitHub 入口。

## 数据边界

演示只使用预设合成数据，不调用模型、不读取微信、不持久化输入。主动点击复制时写入剪贴板；剪贴板不可用时提示用户手动复制。最终发送始终由用户完成。

## 验证

JavaScript 使用 `node --check website/app.js` 检查语法。迁移前已通过浏览器验证回复与改写切换、候选编辑复制、架构节点说明。官网仅介绍模块职责，不代表所有产品集成已经端到端验收。
