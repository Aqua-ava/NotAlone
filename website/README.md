# NotAlone 官网

已确认的单页官网，使用原生 HTML、CSS 和 JavaScript，无构建依赖。

## 本地预览

在仓库根目录执行：

```bash
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate NotAlone
python -m http.server 4174 --bind 127.0.0.1 --directory website
```

访问 http://127.0.0.1:4174/ 。

## 部署与同步

正式站点由 nginx 托管服务器 `example.invalid` 上的 `/var/www/notalone`，访问
<http://example.invalid/notalone/>（注意结尾斜杠）。服务器根路径 `/` 返回 404，留给后续服务，
不占用。nginx 站点配置为 `/etc/nginx/sites-available/notalone`：`root /var/www` 配合目录名
`notalone` 映射 URL 前缀，无需 alias；`/notalone` 会 301 到 `/notalone/`，静态资源缓存 7 天，
HTML 不缓存，启用 gzip。配置已启用并随系统启动。

页面内引用一律使用相对路径（如 `assets/logo.png`），这样在 `/notalone/` 前缀下才能正确解析。

在仓库根目录执行：

```bash
scripts/deploy_website.sh          # 同步一次
scripts/deploy_website.sh watch    # 监听 website/ 改动并自动同步（需要 fswatch）
```

脚本用 `rsync -az --delete` 覆盖远端目录，剔除 `.DS_Store` 与 `README.md`。服务器与远端
路径可用 `NOTALONE_WEB_HOST`、`NOTALONE_WEB_PATH` 覆盖。脚本只传输静态文件，不写入密钥、
不重启服务；改动里新增的资源必须保持相对路径，否则在 `/notalone/` 前缀下会 404。

修改 nginx 配置后需要执行 `systemctl reload nginx` 才会生效；仅 `nginx -t` 只校验语法。

## 页面内容

- 水彩拼贴首屏、帮我回复与帮我改写演示。
- 可编辑候选、依据展开及复制功能。
- 单张技术架构图，点击模块显示职责。
- 产品理念与 GitHub 入口。

## 数据边界

演示只使用预设合成数据，不调用模型、不读取微信、不持久化输入。主动点击复制时写入剪贴板；剪贴板不可用时提示用户手动复制。最终发送始终由用户完成。

## 验证

JavaScript 使用 `node --check website/app.js` 检查语法。迁移前已通过浏览器验证回复与改写切换、候选编辑复制、架构节点说明。官网仅介绍模块职责，不代表所有产品集成已经端到端验收。

部署后经外网核验：`/notalone/` 与本地 `index.html` 逐字节一致，`style.css`、`app.js`、
`assets/logo.png` 均返回 200，`/notalone` 301 到 `/notalone/`，根路径 `/` 返回 404。
