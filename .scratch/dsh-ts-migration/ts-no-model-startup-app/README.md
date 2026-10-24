# TS 未配置态实际 App 验收

根已在组合 26 路径实际合入并通过正式分层验证后执行。显式 typescript、无 key，以 --without-owner 覆盖全新安装；仅合成隔离库，不读取真实资料或微信，不继承 provider／代理配置。

启动前preflight必须确认可复用实例或隔离启动；桌面只npm run dev，不打包。私有随机_test库/userData，八项零计数，Computer Use看实际设置/管理或首次使用页面，经应用菜单正常Quit，status/cleanup须确认全部自有进程退出、连接0才DROP（无FORCE）。

已按冻结候选实际 runtime/status.reply 加入严格断言：runtime=typescript、state=unconfigured、reason=reply_model_unconfigured；两态均不带 key，因此缺 key 原因优先于缺 owner。已有 owner 时 Skill 管理须 typescript，无 owner 时须 unavailable。空生成请求须保留原公开 503 reply_unavailable／owner_uninitialized；随后再核八项计数 0，不以所有权代替就绪能力。

已有 owner／缺 key：实际联系人页已连接，设置页显示 DeepSeek 尚未配置，Skill 页可进入并提示选择联系人。未初始化 owner／缺 key：页面明确提示本人身份未就绪，设置页可初始化本人；在独立受控配置下由 Computer Use 初始化纯合成本人，观察停读／重新加载后恢复已连接，密钥仍未配置。proof-initialized 核 owner 1、runtime_owner_configured=true、skillsOwner=typescript，公开生成仍 503 reply_unavailable；消息、渠道、同步范围、模型回执及外部调用均 0。

首次初始化测试发现 restart-failed；根保留原 fixture、初始 proof／cleanup 和观察在 initialization-disabled-dotenv/。独立真实 SetupController→BackendHost→官方 DSH／Legacy 两次 RED，再只移除禁读开关 GREEN，加回再次 RED。原 TS HostStorage 与 Python runtime_config 明确遵守 NOTALONE_DISABLE_DOTENV=1；该测试开关阻止读取自己刚保存的 owner，不是由此更改产品。诊断见 ../setup-restart-red-repro/hypothesis-checks/findings.md。

修正后的 fixture 清空继承环境，并将父／子进程 NOTALONE_ENV_FILE 显式锁定本轮 synthetic.env；TS 只读该显式文件，Python 有显式路径时不搜索项目 .env。允许初始化后重读该文件，未输入凭据。保留原失败，实际修正后初始化已重新通过 CUA 和公开状态核对。

三次实例均通过菜单正常退出并观察停读，runner／开发／孤儿进程归零，连接 0 后无 FORCE 清理自有库和目录；每态 cleanup JSON 为 DB0／dirs0／共享 PG 可用，最终 preflight 为 stopped，development／packaged／orphaned 为 0。后续不把旧失败用例称为产品缺陷，也不抹掉它。
