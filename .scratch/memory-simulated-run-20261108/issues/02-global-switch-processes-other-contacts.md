# 02 总开关全局生效，无法只处理单个联系人；manual 配置未传到后台子进程

Triage: needs-triage
State: open

## 现象
只想处理联系人 A，开启总开关并对 A 启动历史后，调度器自动为联系人 B、C 建立 `history-auto:` run，并向模型发送了 B 360 条、C 50 条消息。

## 证据
- `startHistory` 要求总开关开启（`requireAutomatic`），开关是库内全局偏好。
- 以 `NOTALONE_BACKGROUND_PROCESSING=manual pnpm run dev` 启动：Electron 主进程环境含该变量，但后台子进程（backend-ts）环境不含，因此仍按默认 `automatic` 启动调度。该变量只会从 `.env` 读取（`sqlite-model-config.ts` 白名单）。
- 调度显示全局待处理文字 32826 条、图片 1699 张；开启开关会让其余已授权联系人逐步被处理。

## 待修
- 让开发/用户能以受支持方式只处理指定联系人（例如开关按联系人，或 manual 模式真正生效）。
- 开启全局开关前向用户说明会处理哪些联系人及外发量。
- 让 `manual` 环境变量传到后台子进程，或在文档中说明只读 `.env`。

## Comments
