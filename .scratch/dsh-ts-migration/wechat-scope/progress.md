# 18 微信范围与绑定验收交付

状态：实现、双轴审查及合成开发 App 验收完成；本票50文件已本地提交 b4276969，待主协调最终签收。

- 已释放实际 App 独占：两轮均通过 npm run dev 启动并用 Computer Use 操作，已退出；没有打包、真实微信访问、模型调用或外部消息。
- 已释放 host-plugin.ts、legacy-backend.ts、server/app.py、command.py 的共享装配独占，最终代码可供主协调接续。
- 默认 selected/false；列表显式刷新且不预选；全部私聊须明确选择；历史快照只覆盖确认时的绑定，新增不继承。108 及升级测试已由主协调提交 db1d9cbd，不重复暂存。
- TS 持有账号、绑定、范围和历史授权写入；旧 Python 入口固定拒绝，远程端口独立认证。公开撤销先经 Python 排空在途同步，再回调 TS 事务撤销，不逐请求回退。
- 双轴审查均已复核关闭 finding：路径规范化前认证漏洞、撤销未排空、饱和列表被误判完整；额外显式重绑历史受旧排除阻挡也已修复。审查结论不等同于审查者重跑测试。
- 最终 TS 7 文件 58/58：wechat-setup、wechat-sessions、binding-service、sync-scope、sync-scope-migration、wechat-scope-api、wechat-scope-host；实际官方 profile 与原始 HTTP socket 均覆盖。
- 最终 Python 4 模块 22/22：test_wechat_scope_remote、test_wechat_history_scope、test_wechat_scope_drain、test_wechat_scope_handoff；此前相关历史回归139及撤销相关61通过。
- 最终 UI 3 文件 32/32：wechat-setup、wechat-setup-view、binding-startup；两端 npm run typecheck 通过。首次UI复跑因未指定已安装Chrome路径失败，补 NOTALONE_TEST_CHROMIUM_PATH 后32/32，未安装浏览器。
- 实际 App 场景一：首次检测默认所选/无历史；列表甲乙均未选；只绑定甲后乙保持未授权；撤销显示自动同步未开启及历史资料保留。
- 实际 App 场景二：全新合成库明确选全部私聊，历史仍默认未选；主动勾选历史后确认，界面显示全部私聊、已授权2会话；PG核验2绑定/2历史快照。fake CLI拒绝正文，界面显示历史不完整，未误报完整。
- 两轮临时App目录清理前15,342,355及23,037,405字节，清理后0；两个随机_test数据库均确认无连接后删除，未停共享PG。开发进程退出，未保留合成身份/截图到仓库。
- 数据影响：原105账号授权记录不改；108只对旧accepted有效绑定回填；按owner/contact隔离，摘要不留存；原生探针替换为退出程序，不采集视觉帧。
- 工具准备仍沿原01/03首用任务，未实现部分不宣称完成；此验收不认证真实微信正文读取或真实模型集成。

详细版本、命令和待提交路径见 integration-request.md。主协调已分配Git独占并完成本地提交；未push。

## 已释放与Git申请

两个开发监督器及其App均已退出，两个本票临时库/目录均已清理；共享host四文件与App独占已释放。最终无待修finding，已按分配完成Git操作，索引将在本记录提交后释放。精确路径见commit-files.txt（50个文件，不含主协调已提交108及root-host证据）。

原首用工具缺口：[01微信准备可行性](../../local-app-first-use/issues/01-wechat-preparation-feasibility.md)仍open；[03微信组件准备](../../local-app-first-use/issues/03-wechat-component-preparation.md)仍open并依赖01，两票尚无登记执行负责人，由主协调分配；18不替代这两票或宣称已完成真实组件准备。

## 提交与最终交接

实现提交 b42769691ff03bc7478627f1f436deaa648ffc47，仅含commit-files.txt列出的50文件。提交后公开历史扫描：14,092 blobs、2,156 commits、3,764 current files，issues=0。共享host/App均已释放；本交接记录提交后释放Git索引，主协调可分配09接线与下一票Git。票18保持claimed等待主协调最终签收planning。
