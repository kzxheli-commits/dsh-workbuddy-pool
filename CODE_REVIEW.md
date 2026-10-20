# 代码审查报告

审查对象：`dsh-workbuddy-pool` 0.4.34 → 0.4.35
审查时间：2026-10-20
审查范围：`lib/`（16 个模块 + 1 个内置依赖）、`test/`、插件清单、文档

## 结论

代码可以公开发布。审查中修复了 1 处安全加固项、1 类死代码、清单元数据与工程化缺失；
剩余项均为「已记录、可控」，不阻塞发布。

| 维度 | 结论 |
|---|---|
| 凭据与密钥 | 通过（文件 0600，仅回环传输，日志脱敏） |
| 网络边界 | 通过（仅绑 127.0.0.1，共享密钥鉴权已改为常量时间比较） |
| 注入与执行 | 通过（无 `eval`/`new Function`，`execFile` 仅用于调用已安装的桌面端二进制） |
| 敏感信息 | 通过（仓库内无个人路径、账号、token） |
| 依赖 | 通过（仅 peerDependencies + 1 个内置 MIT 库，许可证齐全） |
| 测试 | 通过（离线 35 项、静态契约 23 项） |

## 已修复

### 1. 回环端点密钥比较不是常量时间（安全）

`lib/shim.js` 原本用 `presented === token` 比较共享密钥。虽然密钥是每次安装生成的
32 字节随机值、且端点只绑回环，字符串比较仍会按字节提前返回，理论上存在时序侧信道。

改为等长校验 + `crypto.timingSafeEqual`：

```js
function secretEquals(presented) {
  const given = Buffer.from(typeof presented === "string" ? presented : "", "utf8");
  const expected = Buffer.from(token, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

### 2. 29 个无引用的界面文案键（死代码）

历次改版移除了「连接与安全」卡片、自动刷新开关、统计折叠等界面，对应文案键
（`conn*`、`legendShow`、`importClose`、`autoRefresh*`、`statAutomation`、`statsToggle*`、
`settingsNavAbout`、`settingsNote`）已无引用。中英字典同步删除，共 58 行。

### 3. 插件清单缺元数据

`package.json` 补齐 `author`、`keywords`，`files` 纳入 `NOTICE.md` / `SECURITY.md`，
`private` 显式置为 `false`。

> 审查过程中一度把 `repository` 误填为参考项目地址，已移除——那会把别人的仓库声称为本项目的来源。

### 4. 工程化文件缺失

新增 `.gitignore`（排除 `node_modules`、`*.tgz`、运行时状态与日志）、`.gitattributes`
（统一 LF）、`NOTICE.md`（第三方组件与图标来源）、`SECURITY.md`（凭据与网络边界说明）。

## 已记录、未改动的观察项

| 项 | 位置 | 说明 | 风险 |
|---|---|---|---|
| 聊天请求体上限 64 MiB | `lib/util.js` | 回环端点接受大请求体；调用方必须持有该区域密钥 | 低 |
| 凭据目录权限 | `lib/store.js` | 文件写入用 `0600`，目录本身未显式 `0700`（继承父目录） | 低 |
| at-rest 密钥获取 | `lib/at-rest.js` | 通过 `execFile` 运行已安装的桌面端二进制，超时 10 秒、失败后退避 60 秒；无桌面端时明确报错而不是猜测密钥 | 中（功能边界，非安全缺陷） |
| 无 lockfile | 仓库根 | 插件只声明 peerDependencies，`qrcode-generator` 以内置文件形式固定版本；不需要 lockfile | 低 |
| 侧栏图标为位图 | `lib/client.js` (`ICON_PNG`) | 18×18 下细节有损失；如需更清晰应改为手绘 SVG 路径（可跟随 `currentColor`） | 低（观感） |
| 上游能力字段多形态 | `lib/upstream.js` | `supportsImagesOf()` 兼容布尔、模态列表、`capabilities.vision` 三种写法；形状未知时按「不支持」处理 | 低 |

## 建议的后续工作

1. 侧栏图标改为手绘 SVG（`currentColor`），彻底摆脱位图缩放。
2. 若未来引入 npm 依赖，补 `pnpm-lock.yaml` 并开启依赖审计。
3. 为 `lib/at-rest.js` 的密钥获取路径补一条集成测试（当前仅有离线单测覆盖解析与解密）。

## 审查方法

- 逐文件阅读安全敏感模块：`shim.js`（鉴权、body 上限）、`at-rest.js`（密钥与子进程）、
  `store.js`（落盘与迁移）、`routes.js`（写路由守卫）、`credentials.js`（凭据发现）。
- 全仓库检索：`eval`、`new Function`、`child_process`、硬编码 token/密码、个人路径。
- 运行现有测试套件与静态契约检查。
- 发布前用 `git ls-files` 核对暂存内容，确认无运行时状态、打包产物、临时素材。
