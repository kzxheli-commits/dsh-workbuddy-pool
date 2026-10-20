# 第三方组件与素材声明

本项目以 MIT 许可发布（见 `LICENSE`）。以下组件/素材来自第三方，按各自许可使用。

## 参考实现

- [`2861292267/DSH-Official-WorkBuddy-Credit-Proxy`](https://github.com/2861292267/DSH-Official-WorkBuddy-Credit-Proxy)（MIT）
  本项目为独立实现，仅参考其公开行为与字段级规格（上游地址、请求头、错误归类、会话粘性、扫码 `state` 握手），**未复制其代码文件**。
- 其上游 [`XDTrees/dsh-workbuddy-xdpool`](https://github.com/XDTrees/dsh-workbuddy-xdpool)
- 凭据解密思路参考 [`dingminhua/dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy)

## 运行时依赖

| 组件 | 许可 | 用途 |
|---|---|---|
| `@earendil-works/pi-ai` | 见上游 | 模型调用（peer dependency） |
| `@deepseek-ai/dsh-llm` / `dsh-llm-pi-ai` | 见上游 | Harness 适配器（peer dependency） |
| `@deepseek-ai/cordis` / `schemastery` | 见上游 | 插件框架与配置校验（peer dependency） |
| `qrcode-generator`（内置于 `lib/vendor/qrcode.mjs`） | MIT，© 2009 Kazuhiko Arase | 本地生成登录二维码 |

`lib/vendor/qrcode.mjs` 保留了上游版权头。

## 图标

`icon.png` / `assets/icon-*.png` 由 WorkBuddy 官方标识改造而来（裁去文字、垂直镜像、黑白化），
仅用作本插件的图标。WorkBuddy、CodeBuddy 等名称与标识归其权利人所有，本项目与腾讯无隶属关系。
