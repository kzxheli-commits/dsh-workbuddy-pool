# Security

## 凭据如何存放

- 插件**只读** WorkBuddy 桌面端的 auth 目录，从不改写它。
- 扫码登录与粘贴导入的凭据写入 `<DSH 安装目录>/workbuddy-pool/credentials/`，文件权限 `0600`。
- 回环端点的共享密钥保存在 `<DSH 安装目录>/workbuddy-pool/shim-secret-*`，权限 `0600`，每次启动复用。
- 卡片与日志只出现脱敏标签（手机号只保留末 4 位）与 token 指纹。

## 网络边界

- 两个回环端点只绑定 `127.0.0.1`（默认 18120 / 18121），请求必须携带该区域的共享密钥；`GET /healthz` 是唯一例外，便于探活。
- 卡片写路由要求 `Content-Type: application/json` + 回环 `Origin`/`Host`：跨站 JSON POST 会触发不会被批准的预检，跨站表单发不出 JSON 的内容类型。
- 上游请求只发往 WorkBuddy / CodeBuddy 网关；二维码由本机渲染（`/plugins/dsh-workbuddy-pool/qr.svg`），登录链接不会发给任何第三方图像服务。

## 报告问题

发现安全问题请提 issue（不要附带真实 token 或完整凭据文件）。请附：DSH 版本、插件版本、复现步骤、脱敏后的错误信息。
