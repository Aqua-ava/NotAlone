# 长期偏好桌面无损修订组件验证

日期：2026-10-24。只归档9文件桌面完整链及本记录，09整票仍claimed。

## 隔离方式

基线 `cd00e23c4d1c11f409067647df394e99291c7a8b`；精确9文件暂存源码树 `328f88048aae2e17ac48e007dc0f93aba2b33166`。使用git archive展开完整暂存树至独立临时目录，只链接现有desktop/node_modules以复用锁定依赖。未链接原工作树源码；不包含其他未提交后端、Python夹具、05删除端口或共享业务宿主。

## 验证结果

在该独立树的desktop目录使用既有锁定Node运行：

1. `node --test tests/expression-preferences/bigint.test.mjs`：4/4通过，0跳过，1.19秒。覆盖整数数字wire、结构化克隆、修改/删除幂等重试、真实HTTP兼容与生产React编辑。
2. `npm run typecheck`：退出0。
3. `node --test tests/async-reply-preparation.test.mjs`：8/8通过，0跳过，10.83秒。覆盖共享JsonClient异步准备、取消、身份校验与旧协议兼容。

先通过4项再执行类型检查与8项。未扩跑完整偏好29项，未启动实际App、PG或外部模型。临时测试数据均为合成内容；没有真实联系人、聊天或消息发送。

## 提交范围与限制

新增无损JSON codec及专属测试；桌面共享HTTP编解码、偏好bridge/client/controller、共享revision类型和两个React展示组件一起纳入。保留数字JSON协议，内部以bigint保存超安全整数，普通安全整数和浮点行为不变。

独立源依赖扫描66文件，仅新codec未跟踪；所有7个已有修改源文件均在本组件，未发现未提交的外部源码依赖。实际Electron大revision往返证据已另记validation.md，此处不以整合App结果替代隔离树验证。

不纳入两份109Python夹具、记忆菜单测试、App会话夹具、09服务及05 erasure。该组件可独立归档，但09整票仍待其余业务闭包和提交，不能据此resolved。
