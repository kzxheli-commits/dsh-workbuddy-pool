# WorkBuddy Pool · DSH 插件

> **参考项目**：[`2861292267/DSH-Official-WorkBuddy-Credit-Proxy`](https://github.com/2861292267/DSH-Official-WorkBuddy-Credit-Proxy)（MIT）
>
> 本项目是独立实现，参考该项目及其上游 `XDTrees/dsh-workbuddy-xdpool` 的公开行为与字段级规格（上游 URL、请求头、错误归类、会话粘性、扫码 `state` 握手），**没有复制其代码文件**；凭据解密思路来自 `dingminhua/dsh-connect-workbuddy`。细节见下文「与参考实现的关系」。

把 **本机已登录 / 扫码登录 / 粘贴导入** 的 WorkBuddy（腾讯 CodeBuddy）账号合并成一个**自动故障转移的模型池**，通过一个只绑回环的端点同时服务三种协议：

| 协议 | 端点 | 典型客户端 |
|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` | DeepSeek Harness 本体、普通 OpenAI SDK |
| OpenAI Responses | `POST /v1/responses` | Codex、Responses 客户端 |
| Anthropic Messages | `POST /v1/messages` | Claude Code、Anthropic SDK |

DSH 侧注册两个 provider：**WorkBuddy 积分池（国内）** 与 **WorkBuddy 积分池（国际）**，模型选择器里直接可选。账号轮换、冷却、熔断、额度门槛全部发生在回环端点内部，三条协议共用同一套调度。

## 与参考实现的关系

本项目是**独立实现**，设计与字段级规格参考了 MIT 许可的 [`2861292267/DSH-Official-WorkBuddy-Credit-Proxy`](https://github.com/2861292267/DSH-Official-WorkBuddy-Credit-Proxy)（其上游为 `XDTrees/dsh-workbuddy-xdpool`，凭据解密思路来自 `dingminhua/dsh-connect-workbuddy`）。没有复制它的代码文件；行为对齐的点（上游 URL / header / 错误归类 / 会话粘性 / 扫码 state 握手）都在对应模块注释里写明了依据。

相对参考实现，这里主动补掉了它记录在案的五处缺口：

1. **冷却到期不是"全放"**：每账号有租约上限与冷却计数，429 与 5xx 分开计数；
2. **粘性不跨账号污染**：异常换号后重新绑定，避免失效账号被反复抽中；
3. **额度门槛可恢复**：余额低于门槛只是跳过，余额回升后自动回到池中；
4. **凭据目录按平台计算**：macOS / Linux / Windows 各自的桌面端路径都参与扫描，不再硬编码 `%APPDATA%`；
5. **手机号脱敏**：标签里出现的 11–15 位号码只保留末 4 位。

## 账号从哪来

按优先级扫描，全部**只读**，不会改写桌面端自己的文件：

1. `$WORKBUDDY_AUTH_FILE` 指向的目录；
2. WorkBuddy 桌面端 auth 目录：
   - Windows：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth`、`%APPDATA%\...`；
   - macOS：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth`；
   - Linux：`$XDG_CONFIG_HOME`（或 `~/.config`）下同后缀；
3. 本插件自己的导入目录：`<DSH 安装目录>/workbuddy-pool/credentials`（扫码登录与粘贴导入写到这里；插件不再写入桌面客户端目录）。

> **数据存放位置**：插件写入的所有状态都在 **DSH 安装目录**下新建的 `workbuddy-pool/` 文件夹里（安装根按 `DSH_INSTALL_DIR` → 含 `bin/dsh` 的目录 → `DSH_HOME` 依次识别）。从旧版本升级时，`$DSH_HOME/.workbuddy-pool` 会在首次启动自动迁移过去。

桌面端 5.6.0 起 `accessToken` 等字段是 **AES-256-GCM 加密信封**。插件会尝试通过 `ELECTRON_RUN_AS_NODE=1` 运行已安装的桌面端二进制，取回它自己的 at-rest 密钥再解密；**没有桌面端的环境（例如 Android / 纯 Web）无法解密这类文件**，卡片会明确提示改用扫码登录或粘贴明文 `.info`。

### 三种添加方式（都可以重复做，加多少账号都行）

- **桌面端已登录**：不用操作，启动后自动发现（多个账号快照会各自成为一条）；
- **扫码添加账号**：卡片右上「扫码添加账号」→ 在窗口里选区域（国内 / 国际）→ 点「开始登录」→ 手机扫码或打开返回的登录链接 → 插件轮询确认并写入凭据。**成功后窗口保持打开**，点「再添加一个账号」可以立刻换号继续扫；
- **粘贴添加账号**：卡片右上「粘贴添加账号」，把任意一个 `.info` 文件的完整内容（形如 `{"auth":{"accessToken":...}}`）粘进去；**提交后窗口不关闭、输入框清空**，可以接着贴下一个账号。

每个账号按 id 单独落盘（`imported-<region>-<id8>.info`），扫描时按 id 合并，重复导入同一个账号只会刷新令牌，不会变成两条；不同账号则各自成为一个池成员。

## 安装

本插件是 DSH bundle，装进 profile 后出现在插件列表，并在设置卡片提供完整页面。

```bash
# 1. 打包（仓库根目录）
npm pack                      # 生成 dsh-workbuddy-pool-<version>.tgz

# 2. 把 tgz 放进 profile 自己的 vendor/ 目录，用相对路径依赖
#    （不要让依赖指向聊天软件下载目录、临时目录这类会被清理的位置）
cp dsh-workbuddy-pool-<version>.tgz "$DSH_PROFILE_DIR/vendor/"
# package.json: "dsh-workbuddy-pool": "file:vendor/dsh-workbuddy-pool-<version>.tgz"
dsh plugin --profile <profile> install
```

> 为什么强调 vendor：pnpm 对 `file:` tarball 依赖是**每次 install 重新读文件并重算 integrity**（lockfile 里的 integrity 和 store 缓存都救不了），文件一旦被清理，之后任何一次装/卸插件都会以 `ENOENT` 失败。把 tarball 放进 profile 内，profile 自身就是完整的安装源；相对路径还能跟着 profile 一起搬。
>
> 还有一个坑：**同版本替换 tarball 不会生效**——pnpm 按"路径 + 版本"判断，只更新 lockfile 的 integrity，`node_modules` 里仍是旧内容（`--force` 也一样）。升级时要么提升版本号，要么先删掉 `node_modules/<包名>` 再 install。

装好后**完全退出再启动 DSH**：宿主插件不做热重载，运行中的进程仍在使用旧模块表。重启后：

- 模型选择器出现 **WorkBuddy 积分池（国内）/（国际）** 两组；
- 左侧栏出现 `◍` 图标（WorkBuddy 池页面）。页面分两个视图（地区切换为 国内版 / 国际版 / ⚙ 设置）：
  - **账号池视图**（国内 / 国际）：4 张统计卡（**自动化成果**、账号、积分、今日请求）+ 账号池卡片；「自动化成果」显示今日自动化领取的积分与奖励项数，并按任务拆分明细、附近 7 天/本月累计。**所有池操作都在这里**：卡片右上角是「扫码添加账号 / 粘贴添加账号 / 重扫账号」（前两个都可重复使用），账号列表上方一排是「刷新 / 刷新积分 / 清除冷却」，右侧显示扫描时间；账号卡默认只显示状态、余额、在途与冷却，其余收进「详情」；
  - **⚙ 设置**：进入后先是一横排三个分页选择（**模型 / 请求 / 自动化**），选中后下方**只用一张卡片**呈现内容——模型（卡内切换国内/国际，展示完整目录、各自保存；快捷选择仅「全选 / 全不选」；吸底保存条；每模型带上下文/倍率/采样与 tok/s）、请求（明细 5 列 + 同一卡内可折叠的按模型统计）、自动化（开关 + 收益 + 任务行：首行右侧是单任务「立即执行」，下方是下次/最近执行，逐账号成果始终展示并带本次积分；「立即执行全部」带确认与 n/5 进度）；连接与安全/数据来源信息收在卡片下方的折叠入口里，默认收起；
  - 页头只保留身份与状态：标题、版本、上次更新、自动化状态、自动刷新开关；
- 回环端点：国内 `http://127.0.0.1:18120`、国际 `http://127.0.0.1:18121`（`cnPort`/`globalPort` 可改）。

## 配置（插件行 Config）

| 字段 | 默认 | 含义 |
|---|---|---|
| `cnPort` / `globalPort` | `18120` / `18121` | 回环端口，`0` = 随机 |
| `maxAttempts` | `8` | 单次请求最多尝试的不同账号数 |
| `cooldownMs` | `60000` | 限流冷却 |
| `cooldownMaxMs` | `7200000` | 限流冷却上限 |
| `serverCooldownMs` | `15000` | 网关故障冷却（与 429 分开计数） |
| `hardCreditCooldownMs` | `1800000` | 积分耗尽后的休息时长 |
| `breakerThreshold` / `breakerMs` | `3` / `1800000` | 连续被拒多少次后移出轮换 / 移出时长 |
| `leaseLimit` | `2` | 单账号并发上限，达到后让路 |
| `minUsableCredits` | `50` | 余额低于该值不派活（0 关闭） |
| `distribution` | `balanced` | `priority` / `round-robin` / `balanced` |
| `modelSelectionCn` / `modelSelectionGlobal` | — | 每区域启用的模型、上下文窗口覆盖 |
| `automation` | 关闭 | 每项任务的执行小时（见下） |

卡片里改的东西（账号启停、保留线、模型勾选、自动化开关与时刻）写 `<DSH 安装目录>/workbuddy-pool/settings.json`，重启后仍在。

## 每日积分自动化

开启后按本地时间执行（错过的时段在启动后补跑一次）：

| 任务 | 默认时刻 | 内容 |
|---|---|---|
| 签到 | 09:00 | 查状态 + 领取当日签到 |
| 活跃上报 | 10:00 | `chat_request_send` 活跃事件，回读连登天数验证不是静默丢弃 |
| 任务奖励 | 11:00 | 报名开放任务 → 领取可领奖励 |
| 连登奖励 | 12:00 | 兑换已解锁档位 + 有次数就抽奖 |
| 猫猫旅行 | 09:00 / 21:00 | 同意条款 → 领养 → 出发 / 领取 |

每次运行结果（每账号、状态、收益）都落盘并在卡片「自动化」页展示；收益账本按天累计。

## 协议细节

- 上游 chat 永远是流式的，非流式请求由插件把 SSE 重组为完整响应；
- 工具调用在 Chat / Responses / Anthropic 三套词表之间互译，`tool_use` ↔ `tool_calls`、`stop_reason: tool_use`、`input_json_delta` 都按各自协议发送；
- `role: "developer"` 转 `system`、`tool_choice` 扁平化、`tool_calls`↔`tool` 结果配对修复后再发上游（上游对不配对的历史直接回 11148）；
- **系统提示脱敏**：网关对系统提示里的竞品品牌句做内容拦截，却伪装成"渠道校验失败"返回 `400 + code 11128`。实测只有 system 消息里的 `DeepSeek Harness` 精确签名会被拦（user/assistant/tool 消息、工具描述都放行），插件发上游前把它改写成 `DSH`，代价是模型看到的产品名变短，换来不被误判成"非官方客户端"；
- 错误归因诚实：池为空时报告是"限流 / 额度耗尽 / 全部停用 / 需要重新登录"中的哪一种，而不是一律 401。

## 安全

- 回环端点只绑 `127.0.0.1`，每个区域一个 32 字节共享密钥（`<DSH 安装目录>/workbuddy-pool/shim-secret-*`，权限 0600），请求必须带 `Authorization: Bearer <secret>`；没有密钥的 `GET /healthz` 也放行，便于探活；
- 设置卡片的写路由要求 `Content-Type: application/json` + 回环 Origin + 回环 Host：跨站 JSON POST 会触发不被批准的预检，而跨站表单发得出却声明不了 JSON，这道校验才是真正的写边界；
- 凭据只在内存与回环端点之间传递；卡片与日志只出现脱敏标签与 token 指纹。

## 已知限制

- **没有 WorkBuddy 账号就没有流量**：池为空时 provider 仍然注册、18 个兜底模型仍可见，但任何请求都会得到明确的"无账号"错误；
- **加密凭据需要桌面端**：纯 Web / Android 环境无法解开 `$wbEncrypted`，请用扫码或粘贴明文；
- **扫码登录需要手机确认**：插件只负责发起与轮询，扫码动作由用户完成；
- **国际区域目录**依赖国际账号：没有国际账号时国际 provider 用静态兜底模型；
- **网关策略随云端变化**：上游会在服务端随时加规则（例如 2026-10-20 起拦截系统提示里的竞品品牌句，伪装成 `11128` 渠道校验）。插件只能按实测结果改写请求体；遇到新的"账号正常但每轮都 400"时，先看错误码再重放请求体定位；
- 宿主插件不支持热重载，改代码或升级后必须重启 DSH。

## 验证

```bash
node test/run.mjs                  # 37 项：池/协议/自动化/凭据（mock 上游 + 真实 HTTP）
node test/check-provider.mjs       #  5 项：真实 PiAiAdapter → shim 的适配器契约
node test/check-client-static.mjs  # 23 项：词典/路由/主题令牌/Slot/可重复添加账号的静态校验
```

`check-provider.mjs` 需要宿主依赖（`@deepseek-ai/dsh-llm-pi-ai`、`@earendil-works/pi-ai`）可解析；在本仓库里可先 `ln -s "$DSH_PROFILE_DIR/node_modules" node_modules`（该软链不随包发布）。

客户端是浏览器模块，本环境没有浏览器控制，因此**不做**自定义渲染器/截图式验证；`check-client-static.mjs` 只校验能被静态证明的契约（模块入口、双语词典 1:1、每个 `t()` 键存在、客户端路由与服务端逐条一致、样式只用 `--dsw-alias-*` 主题令牌、Slot 寻址、无 innerHTML 注入路径、每个动作都有 pending/失败反馈）。真正的视觉呈现需要在浏览器里刷新页面确认。

离线套件 28 项，覆盖：凭据解析与解密、区域判定、发现去重、错误归类、429 重置时间、模型目录与选择、池轮换/冷却/熔断/令牌刷新、三协议的真实 HTTP 往返（流式与非流式、工具调用）、配对修复、自动化签到与账本、状态持久化。上游是本地 mock，其余全部是真实模块。

实机验证（本机 profile）另行记录了：provider 注册（两区域各 18 个模型）、shim 密钥鉴权与 401 拒绝、`/v1/models`、三协议的"无账号"错误形状、真实网关下的 401 归因与冷却、扫码 start 返回真实 `authUrl`、客户端模块被页面加载并完成 `main` + `sidebar.panellist` 注册。

## 目录

| 文件 | 职责 |
|---|---|
| `lib/index.js` | Config、apply、provider 注册、启动扫描、后台刷新 |
| `lib/credentials.js` | 桌面端路径、`.info` 解析、区域、账号 id、导入落盘 |
| `lib/at-rest.js` | 桌面端 AES-256-GCM 加密字段解密 |
| `lib/upstream.js` | 上游 HTTP：chat、刷新、目录、积分、错误归类 |
| `lib/pool.js` | 选号、租约、冷却、熔断、额度、请求记录与统计 |
| `lib/catalog.js` | 每区域模型目录 + 静态兜底 + 选择过滤 |
| `lib/shim.js` | 回环 HTTP 服务、鉴权、三协议入口、工具配对修复 |
| `lib/protocol.js` | Chat ↔ Responses ↔ Anthropic 请求/流翻译 |
| `lib/automation.js` | 积分任务实现与调度器 |
| `lib/oauth.js` | 扫码 state 握手登录 |
| `lib/routes.js` | 卡片使用的 `/plugins/dsh-workbuddy-pool/*` 路由 |
| `lib/settings.js` | 卡片可写状态（JSON 持久化） |
| `lib/client.js` | 浏览器端整页 UI + 侧栏图标 |

## 许可

MIT。上游协议的字段级知识来自参考项目及其上游的公开实现（均为 MIT），致谢见文首。
