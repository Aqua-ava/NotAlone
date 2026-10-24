# Skill宿主实际App验收入口

仅根执行；候选12实际路径最小1/1、相关41/41、Python21/21及strict通过后，使用此新合成包/随机_test库/userData启动npm run dev。默认模型仍Python、无key、无微信、总开关关闭；启动先preflight复用门。

已完成实际 App 验收。现有 Skill 页面展示版本历史；普通导入、预览、启停及删除经原公开管理 API 执行，再用 Computer Use 刷新页面核对同一 Skill 的 v1、正文及状态，没有新增或假称已有导入／导出按钮。

测试只创建一位合成联系人和一条数据库内合成 active binding，以满足旧历史页的绑定要求；未连接微信。初次仅手录授权时旧历史接口返回 404，补入合成绑定后为 200 空历史；这是原接口的范围要求。初次包目录名与 frontmatter 不同，按原校验返回 package_invalid；只修正测试目录名，未改产品校验。

`manage-*-proof.json` 记录同一 UUID 的 active→disabled→active→deleted，版本 1→null、历史 1→0；联系人及合成绑定各 1，渠道身份、消息、外部调用、模型回执、已开启同步范围、工作副本及清理待办均 0。不能将添加合成联系人前的八项零计数套用于之后。

Computer Use 通过菜单正常退出，观察“正在停读”后 runner 退出，开发进程和孤儿进程为 0；仅在连接归零后清理自有随机 _test 库及 userData。cleanup-proof.json 记录自有库 0、私有目录 0、共享 PG 仍可用；最终 preflight 为 stopped、development/packaged/orphaned 均 0。没有读取真实聊天、外部模型调用、打包或发送消息。
