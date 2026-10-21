/**
 * Browser half of `dsh-workbuddy-pool`: the WorkBuddy pool page.
 *
 * Design rules for this file:
 *   - every piece of state is presented as a card with a title, a one-line
 *     explanation and its own actions, so the page reads as a dashboard rather
 *     than a bare table;
 *   - every number carries an annotation (what it counts, when it was read,
 *     what "unknown" means), because the pool hides several asynchronous facts
 *     (credits, cooldown, next scheduled run) that are easy to misread;
 *   - every action has an explicit pending/disabled/failed state, and a failure
 *     surfaces as a dismissible toast instead of a silent no-op;
 *   - colours come only from the Host's `--dsw-alias-*` theme tokens, so the
 *     page follows light/dark without its own switch.
 *
 * This file is a `window.__ModuleLoader__` module, not an ES module: the Host
 * serves it to the page and `require("react")` resolves from the browser module
 * table.
 *
 * @module dsh-workbuddy-pool/client
 */

window.__ModuleLoader__.load({
  id: "dsh-workbuddy-pool",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    /** Locale namespace of this page. */
    const NS = "workbuddy-pool";
    /** Panel id, also the `main` slot key and the sidebar entry id. */
    const PANEL_ID = "workbuddy-pool";
    /** Status poll interval, stated next to the refresh control. */
    const POLL_MS = 30_000;
    /** How long a toast stays visible. */
    const TOAST_MS = 4_200;
    /** Automation job order; also the order "run all now" executes them in. */
    const AUTOMATION_KINDS = ["checkin", "report", "tasks", "streak", "travel", "compensation"];
    /**
     * Jobs that are one-off campaigns rather than daily passes.
     *
     * A campaign row is shown only while the server says the offer is still
     * open (`automation.campaign.open`), so the card never advertises a claim
     * that has already closed.
     */
    const CAMPAIGN_KINDS = new Set(["compensation"]);
    /** Dictionary key for each automation job's label. */
    const AUTOMATION_LABEL_KEY = {
      checkin: "autoJobCheckin",
      report: "autoJobReport",
      tasks: "autoJobTasks",
      streak: "autoJobStreak",
      travel: "autoJobTravel",
      compensation: "autoJobCompensation",
    };
    /** QR sign-in polling window, matching the Host route's 180 s budget. */
    const QR_POLL_MS = 2_000;
    const QR_DEADLINE_MS = 180_000;
    /** Route contract; mirrors `lib/routes.js`. */
    const ROUTES = {
      status: "/plugins/dsh-workbuddy-pool/status",
      rescan: "/plugins/dsh-workbuddy-pool/accounts/rescan",
      importAccount: "/plugins/dsh-workbuddy-pool/accounts/import",
      disableAccount: "/plugins/dsh-workbuddy-pool/accounts/disable",
      reserveAccount: "/plugins/dsh-workbuddy-pool/accounts/credit-reserve",
      removeAccount: "/plugins/dsh-workbuddy-pool/accounts/remove",
      refreshCredits: "/plugins/dsh-workbuddy-pool/accounts/refresh-credits",
      oauthStart: "/plugins/dsh-workbuddy-pool/oauth/start",
      oauthPoll: "/plugins/dsh-workbuddy-pool/oauth/poll",
      qr: "/plugins/dsh-workbuddy-pool/qr.svg",
      resetCooldowns: "/plugins/dsh-workbuddy-pool/cooldowns/reset",
      saveModels: "/plugins/dsh-workbuddy-pool/models/save",
      refreshModels: "/plugins/dsh-workbuddy-pool/models/refresh",
      automationRun: "/plugins/dsh-workbuddy-pool/automation/run",
      automationConfig: "/plugins/dsh-workbuddy-pool/automation/config",
    };

    /* ------------------------------------------------------------------ *
     * Dictionaries (zh is the source language; en mirrors every key 1:1)
     * ------------------------------------------------------------------ */

    const zh = {
      nav: "WorkBuddy 池",
      title: "WorkBuddy 积分池",
      subtitle: "WorkBuddy 账号池：自动轮换与故障转移，三个协议共用一个回环端点。",
      versionLabel: "版本",
      lastUpdated: "上次更新",
      neverUpdated: "尚未更新",
      refresh: "立即刷新",
      refreshHint: "立即重新读取状态，不会触发模型请求。",

      regionCn: "国内版",
      regionGlobal: "国际版",
      regionHint: "国内与国际是两个独立 provider 与账号池；切换标签只影响本页展示。",
      regionCnHint: "网关：copilot.tencent.com / www.codebuddy.cn",
      regionGlobalHint: "网关：www.workbuddy.ai（codebuddy.ai 账号走 www.codebuddy.ai）",

      actionRescan: "重扫账号",
      actionRescanHint: "重新扫描本机桌面端登录快照与插件导入目录，不会修改桌面端文件。",
      actionCredits: "刷新积分",
      actionCreditsHint: "向每个账号的账单接口读取余额；余额只读，不消耗积分。",
      actionCooldown: "清除冷却",
      actionCooldownHint: "清空限流冷却、网关冷却与熔断标记，下一次请求立即可以重新选号。",
      actionImport: "粘贴添加账号",
      actionImportHint: "导入一份明文 .info 内容（一个文件一个账号），可连续导入多个账号；加密凭据需要桌面端才能解开。",
      actionQr: "添加账号",
      actionQrHint: "添加一个 WorkBuddy 账号：用链接在浏览器登录，或在本页扫码登录。",

      statAccounts: "账号",
      statAccountsHint: "可用 / 总数。可用 = 未停用、未冷却、余额不低于门槛。",
      statCredits: "可用积分",
      statCreditsHint: "各账号余额合计；未知余额不计入，账号卡片里有单账号余额。",
      statModels: "模型",
      statModelsHint: "已启用 / 目录总数。目录来自上游实时拉取，失败时用内置列表。",
      statUsage: "今日用量",
      statUsageHint: "今日成功请求数；括号内为输入/输出 token。",
      statAutomationHint: "开关状态与今日自动化收益；收益只统计自动任务领取到的积分。",
      statAutoResult: "自动化",
      statAutoResultHint: "今日通过自动化领取到的积分与奖励项数；明细按任务拆分，右侧是近 7 天 / 本月累计。",
      autoRewardUnit: "项奖励",
      stateOn: "开启",
      stateOff: "关闭",

      tabAccounts: "账号",
      tabModels: "模型",
      tabRequests: "请求记录",
      tabAutomation: "自动化",
      tabConnection: "连接与安全",
      backToPool: "返回账号池",
      moreActions: "更多操作",
      settingsNavModels: "模型",
      settingsNavRequests: "请求",
      settingsNavAutomation: "自动化",
      accDetails: "详情",
      accDetailsHide: "收起",
      accBalanceReadAt: "余额读取",
      runAllConfirm: "将立即对所有可用账号执行全部自动化任务（会真实调用上游接口），继续吗？",
      runAllTitle: "执行全部自动化",
      runAllGo: "确认执行",
      runAllProgress: "执行中",
      autoDetailsShow: "逐账号结果",
      autoDetailsHide: "收起结果",
      reqTokensHint: "输入 / 输出 token 数",
      settingsTab: "设置",
      settingsHint: "配置模型选择与查看两区域的请求明细。",
      settingsTitle: "设置",
      settingsSub: "模型列表选择、请求明细与自动化设置集中在这里，国内 / 国际两个区域并排展示。",
      settingsModelsTitle: "模型列表选择",
      settingsRequestsSub: "两区域最近请求的合并视图（最多各 100 条），按时间倒序；带区域标记。",

      legendTitle: "状态说明",
      legendHint: "每种状态都有自己的原因与处理方式；冷却到期会自动恢复，无需手动操作。",
      stateReady: "可用",
      stateCooling: "冷却中",
      stateBlocked: "需重新登录",
      stateRestricted: "受限",
      stateDisabled: "已停用",
      stateReadyHint: "可以立即被选号。",
      stateCoolingHint: "刚被限流或网关故障，等倒计时结束自动恢复。",
      stateBlockedHint: "连续被拒，已移出轮换；重新登录或等待窗口结束。",
      stateRestrictedHint: "余额不足或低于保留线，补足积分后自动恢复。",
      stateDisabledHint: "被手动停用，不会参与选号。",

      accountsTitle: "账号池",
      accountsSub: "每个账号一张卡片：状态、余额、来源、最近一次错误都可展开查看。",
      accountsEmptyTitle: "还没有 WorkBuddy 账号",
      accountsEmptyBody: "在装有 WorkBuddy 桌面端的机器上插件会自动读取本机登录快照；没有桌面端时，用扫码登录或粘贴一份明文 .info 导入。",
      scanAt: "最近扫描",
      scanWarnEncrypted: "检测到加密凭据，但本机没有可打开它的桌面端；请用扫码或粘贴明文 .info 导入。",
      scanWarnNone: "扫描完成，未发现账号文件。",
      accCredits: "余额",
      accCreditsUnknown: "未知",
      accCreditsHint: "向账单接口读取的可用积分；点「刷新积分」可重读。",
      accInFlight: "在途",
      accInFlightHint: "当前正在使用该账号的请求数；达到上限时该账号会让路给其他账号。",
      accRequests: "请求",
      accRequestsHint: "该账号累计成功请求数。",
      accLastUsed: "最近使用",
      accNever: "从未使用",
      accCooldownLeft: "冷却剩余",
      accReserve: "保留线",
      accReserveHint: "余额低于该值时不再派活；0 = 跟随全局可用门槛。",
      accReserveSave: "保存",
      accSource: "来源",
      accSourceDesktop: "桌面端登录快照",
      accSourcePlugin: "插件导入（扫码/粘贴）",
      accSourceShortDesktop: "桌面端",
      accSourceShortPlugin: "插件导入",
      accSourceHint: "桌面端快照由 WorkBuddy 应用写入；插件导入的文件只由本插件读取。",
      accRefreshTokenYes: "可自动续期",
      accRefreshTokenNo: "无刷新令牌",
      accRefreshTokenHint: "有刷新令牌时，凭据过期或失效会自动尝试续期一次。",
      accExpires: "凭据到期",
      accNoExpiry: "未提供到期时间",
      accDisable: "停用",
      accEnable: "启用",
      accDisableHint: "停用后该账号不参与选号，但保留在池中。",
      accRemove: "移除",
      accRemoveConfirm: "确认移除",
      accCancel: "取消",
      accRemoveHint: "只移除插件导入的凭据文件；桌面端写入的凭据不会被删除。",
      accLastError: "最近错误",
      accErrorShow: "展开错误",
      accErrorHide: "收起错误",
      accNoError: "没有记录到错误。",
      accRegion: "区域",
      accReserveSaved: "保留线已保存",

      reasonRateLimit: "限流",
      reasonGateway: "网关故障",
      reasonNeedsSignIn: "凭据失效",
      reasonCredits: "积分不足",
      reasonRestricted: "账号受限",
      reasonManual: "手动停用",
      reasonLowCredits: "低于可用门槛",
      reasonBelowReserve: "低于保留线",
      reasonModelCooldown: "部分模型冷却中",
      reasonUnknown: "未知原因",

      modelsTitle: "模型目录",
      modelsSub: "这里控制哪些模型出现在 DSH 的模型选择器里；目录来自该区域的上游账号。",
      modelsSubGlobal: "国际区域的目录由其上游账号提供（/v3/config）；没有国际账号时展示内置兜底列表。",
      modelsSearch: "搜索模型",
      modelsSearchPlaceholder: "按 id 或名称过滤",
      modelsSelected: "已启用",
      modelsDirty: "有未保存的修改",
      modelsSave: "保存",
      modelsDiscard: "放弃修改",
      modelsSelectAll: "全选",
      modelsClearFilter: "改为全部启用",
      modelsAllMode: "全部启用（未自定义）",
      modelsCustomMode: "自定义选择",
      modelsSelectAllHint: "勾选全部模型，保存后等于「全部启用」，以后新增的模型也会自动包含。",
      modelsSelectNoneHint: "取消全部勾选，然后勾选想要的模型；空选择不能保存（会退化为全部启用）。",
      modelsSelectNone: "全不选",
      modelsNoneSelected: "未选择任何模型",
      modelsNoneSelectedHint: "尚未选择模型，至少勾选一个（或点全选）后才能保存。",
      modelsEnableAllHint: "恢复为全部启用，包含以后新增的模型。",
      modelsMatchCount: "匹配",
      modelsClearSearch: "清除搜索",
      modelsSaveBarHint: "保存后立即生效，无需重启",
      modelsUsage: "采样",
      modelsUsageHint: "来自本区域最近的请求统计，样本少时仅供参考。",
      modelsTps: "tok/s",
      modelsFallback: "内置兜底目录",
      modelsLive: "上游实时目录",
      modelsFallbackHint: "还没有成功拉取上游目录，当前展示内置列表；拿到账号后会自动替换。",
      modelsLiveHint: "来自上游 /v2/enterprises/personal/models（国际版为 /v3/config）。",
      modelsContext: "上下文",
      modelsContextHint: "模型可接受的最大输入长度（token）。",
      modelsRate: "倍率",
      modelsRateHint: "上游积分倍率，越低越省；未知表示上游未公布。",
      modelsImages: "图片",
      modelsImagesHint: "该模型是否接受图片输入。",
      modelsNone: "没有匹配的模型。",
      modelsSaved: "模型选择已保存",
      modelsSavedAll: "已保存：全部模型启用",
      modelsRefresh: "刷新上游模型",
      modelsRefreshHint: "立即从该区域的上游账号拉取一次模型目录；不会改动当前选择。",
      modelsRefreshed: "已获取模型",
      modelsRefreshFailed: "刷新失败",

      reqTitle: "请求记录",
      reqSub: "每次经过本地池的调用都会记录账号、结果、排队与耗时，便于判断该用哪个模型。",
      reqRegion: "区域",
      reqFilterAll: "全部",
      reqFilterOk: "成功",
      reqFilterFail: "失败",
      reqEmptyTitle: "还没有请求记录",
      reqEmptyBody: "在 DSH 里选中本池的模型发一条消息后，这里会出现每一次调用。",
      reqTime: "时间",
      reqModel: "模型",
      reqAccount: "账号",
      reqResult: "结果",
      reqQueue: "排队",
      reqQueueHint: "从入池到拿到上游响应头的时间。",
      reqDuration: "耗时",
      reqTokens: "输入/输出",
      reqOk: "成功",
      reqFail: "失败",
      reqKind: "错误类型",
      reqNone: "没有匹配的记录。",
      reqKindHint: "错误类型来自上游归因：限流、凭据失效、积分不足、请求本身有问题等。",

      statsTitle: "按模型统计",
      statsSub: "p50/p95 来自最近 200 次样本；样本越多越可靠。",
      statsSamples: "样本",
      statsQueueP50: "排队 p50",
      statsTotalP50: "耗时 p50",
      statsTps: "tok/s p50",
      statsEmpty: "还没有足够样本。",

      autoTitle: "每日积分自动化",
      autoSub: "到点自动为每个账号领取签到、活跃、任务、连登与旅行收益；任务幂等，可安全重跑。",
      autoEnable: "启用自动化",
      autoEnableHint: "关闭时不会产生任何定时任务请求；开启后按下方时刻执行，错过的时段会在启动后补跑一次。",
      autoEarningsTitle: "自动化收益",
      autoEarningsHint: "只统计自动任务领取到的积分，不含日常对话消耗。",
      autoToday: "今日",
      autoLast7: "近 7 天",
      autoMonth: "本月",
      autoHours: "执行时刻",
      autoHoursHint: "本地时间，逗号分隔，例如 9,21；留空表示不执行。",
      autoHoursInvalid: "时刻必须是 0–23 的整数，用逗号分隔。",
      autoNextRun: "下次执行",
      autoNoNextRun: "今天没有剩余时段",
      autoLastRun: "最近执行",
      autoNeverRun: "尚未执行",
      autoRunNow: "立即执行",
      autoRunHint: "立即对所有可用账号执行一次，不会改变定时计划。",
      autoResults: "逐账号结果",
      autoResultOk: "成功",
      autoResultFail: "失败",
      autoJobCheckin: "每日签到",
      autoJobReport: "活跃上报",
      autoJobTasks: "任务奖励",
      autoJobStreak: "连登奖励",
      autoJobTravel: "猫猫旅行",
      autoJobCompensation: "服务异常补偿",
      autoJobCheckinDesc: "查询签到状态并领取当日积分；已签到视为成功。",
      autoJobReportDesc: "上报一条活跃事件，并回读连登天数确认上报未被静默丢弃。",
      autoJobTasksDesc: "报名开放中的任务，然后领取已达到进度的奖励。",
      autoJobStreakDesc: "兑换已解锁的连登档位，并用剩余次数抽奖。",
      autoJobTravelDesc: "同意条款、领养伙伴、出发旅行或领取已到达的奖励。",
      autoJobCompensationDesc: "领取「DeepSeek 模型服务异常额外补偿」一次性补偿；已领取或活动结束后自动跳过。",
      autoDisabledHint: "自动化为关闭状态；下方按钮仍可手动执行单次任务。",
      autoSaved: "自动化设置已保存",
      autoRunDone: "任务执行完成",
      autoRunAll: "立即执行全部",
      autoRunAllHint: "按 签到 → 活跃上报 → 任务奖励 → 连登奖励 → 猫猫旅行 的顺序，对所有可用账号各执行一次；不会改动定时计划。",
      autoRunAllDone: "全部自动化任务执行完成",


      importTitle: "粘贴导入凭据",
      importHint: "把 WorkBuddy 桌面端 auth 目录里任意一个 .info 文件的完整内容粘贴到这里（形如 {\"auth\":{\"accessToken\":...}}）。加密内容需要桌面端才能解开，纯 Web 环境请改用扫码登录。",
      importPlaceholder: "{\"auth\":{\"accessToken\":\"...\",\"refreshToken\":\"...\",\"domain\":\"www.codebuddy.cn\"}}",
      importSubmit: "导入",
      importAnotherHint: "本窗口可以连续使用：提交后输入框清空，接着粘贴下一个账号的 .info 继续导入即可。",
      importAdded: "已添加",
      importEmpty: "内容是空的。",
      importInvalidJson: "不是合法的 JSON。",
      importOk: "导入成功",

      qrTitle: "扫码添加 WorkBuddy 账号",
      qrHint: "点击开始后，用已登录 WorkBuddy 的手机扫码，或在浏览器打开登录链接完成确认；确认后账号会自动写入池中，可以重复这一步添加更多账号。",
      qrLinkLogin: "链接登录",
      qrLinkLoginHint: "自动在浏览器打开登录页，完成确认后账号加入账号池",
      qrQrLogin: "二维码登录",
      qrQrLoginHint: "在本弹窗内显示二维码，用手机扫码完成登录",
      qrLinkOpened: "已在浏览器打开登录页；完成确认后账号会自动加入",
      qrStarting: "正在申请登录…",
      qrStart: "开始登录",
      qrWaiting: "等待手机确认…",
      qrOpen: "打开登录链接",
      qrCopy: "复制链接",
      qrCopied: "链接已复制",
      qrDone: "登录成功，账号已加入",
      qrAnother: "再添加一个账号",
      qrAnotherHint: "这个窗口会保持打开：换一个 WorkBuddy 账号再扫一次即可继续加入。",
      qrExpired: "登录未完成",
      qrTimeout: "等待超时，请重新发起",
      qrCountdown: "剩余",
      qrClose: "关闭",
      qrRetry: "重新发起",

      toastSaved: "已保存",
      toastImported: "已导入",
      toastRescanned: "已重扫账号",
      toastCredits: "积分已刷新",
      toastCooldown: "冷却已清除",
      toastDisable: "账号已停用",
      toastEnable: "账号已启用",
      toastRemoved: "账号已移除",
      toastCopied: "已复制到剪贴板",
      toastFailed: "操作失败",
      copyFailed: "复制失败",

      loadErrorTitle: "状态读取失败",
      loadErrorBody: "插件路由没有返回状态；可能是宿主正在重载。稍后重试，或检查插件是否启用。",
      retry: "重试",
      footerNote: "数据来源：/plugins/dsh-workbuddy-pool/status · 每 30 秒自动刷新",
      loading: "正在读取状态…",
    };

    const en = {
      nav: "WorkBuddy Pool",
      title: "WorkBuddy Pool",
      subtitle: "WorkBuddy account pool: automatic rotation and failover, one loopback endpoint for all three protocols.",
      versionLabel: "Version",
      lastUpdated: "Updated",
      neverUpdated: "not yet",
      refresh: "Refresh now",
      refreshHint: "Re-reads status immediately; no model request is made.",

      regionCn: "Domestic",
      regionGlobal: "Global",
      regionHint: "Domestic and global are independent providers and pools; this switch only changes what the page shows.",
      regionCnHint: "Gateway: copilot.tencent.com / www.codebuddy.cn",
      regionGlobalHint: "Gateway: www.workbuddy.ai (codebuddy.ai accounts use www.codebuddy.ai)",

      actionRescan: "Rescan",
      actionRescanHint: "Rescans desktop sign-in snapshots and the plugin import directory; desktop files are never modified.",
      actionCredits: "Refresh credits",
      actionCreditsHint: "Reads each account's balance from the billing endpoint; read-only.",
      actionCooldown: "Clear cooldowns",
      actionCooldownHint: "Clears rate-limit / gateway cooldowns and breakers so the next request can re-select any account.",
      actionImport: "Paste import",
      actionImportHint: "Imports plaintext .info content; encrypted credentials need the desktop app.",
      actionQr: "Add account",
      actionQrHint: "Add a WorkBuddy account: sign in through a browser link, or scan a QR code here.",

      statAccounts: "Accounts",
      statAccountsHint: "usable / total. Usable = enabled, not cooling, balance above the floor.",
      statCredits: "Credits",
      statCreditsHint: "Sum of known balances; unknown balances are excluded. Each account card shows its own balance.",
      statModels: "Models",
      statModelsHint: "enabled / catalog total. The catalog is fetched live; a built-in list is used on failure.",
      statUsage: "Today",
      statUsageHint: "Successful requests today; input/output tokens in parentheses.",
      statAutomationHint: "Switch state and credits earned by automation today.",
      statAutoResult: "Automation",
      statAutoResultHint: "Credits and reward count claimed by automation today, split by job; the tail shows the 7-day / month totals.",
      autoRewardUnit: "rewards",
      stateOn: "on",
      stateOff: "off",

      tabAccounts: "Accounts",
      tabModels: "Models",
      tabRequests: "Requests",
      tabAutomation: "Automation",
      tabConnection: "Connection",
      backToPool: "Back to pool",
      moreActions: "More",
      settingsNavModels: "Models",
      settingsNavRequests: "Requests",
      settingsNavAutomation: "Automation",
      accDetails: "Details",
      accDetailsHide: "Collapse",
      accBalanceReadAt: "Balance read",
      runAllConfirm: "Run every automation pass for all usable accounts now? This calls the real upstream.",
      runAllTitle: "Run all automation",
      runAllGo: "Run",
      runAllProgress: "Running",
      autoDetailsShow: "Per-account results",
      autoDetailsHide: "Hide results",
      reqTokensHint: "input / output tokens",
      settingsTab: "Settings",
      settingsHint: "Choose models and inspect request details for both regions.",
      settingsTitle: "Settings",
      settingsSub: "Model selection, request details and automation settings live here, with domestic and global side by side.",
      settingsModelsTitle: "Model selection",
      settingsRequestsSub: "Merged recent requests from both regions (up to 100 each), newest first, tagged with the region.",

      legendTitle: "State legend",
      legendHint: "Every state has its own reason and remedy; cooldowns recover automatically.",
      stateReady: "Ready",
      stateCooling: "Cooling down",
      stateBlocked: "Needs sign-in",
      stateRestricted: "Restricted",
      stateDisabled: "Disabled",
      stateReadyHint: "Can be selected right now.",
      stateCoolingHint: "Recently rate-limited or gateway-failed; recovers when the countdown ends.",
      stateBlockedHint: "Rejected repeatedly and removed from rotation; sign in again or wait.",
      stateRestrictedHint: "Out of credits or below its reserve; recovers once topped up.",
      stateDisabledHint: "Disabled by hand; never selected.",

      accountsTitle: "Account pool",
      accountsSub: "One card per account: state, balance, origin and the last error are all visible.",
      accountsEmptyTitle: "No WorkBuddy account yet",
      accountsEmptyBody: "On a machine with the WorkBuddy desktop app the plugin reads its sign-in snapshots; without the app, use QR sign-in or paste a plaintext .info document.",
      scanAt: "Last scan",
      scanWarnEncrypted: "Encrypted credentials found, but no desktop app is available to open them. Use QR sign-in or paste plaintext .info content.",
      scanWarnNone: "Scan finished; no account file found.",
      accCredits: "Balance",
      accCreditsUnknown: "unknown",
      accCreditsHint: "Usable credits read from the billing endpoint; use Refresh credits to re-read.",
      accInFlight: "In flight",
      accInFlightHint: "Requests currently using this account; at the limit it yields to others.",
      accRequests: "Requests",
      accRequestsHint: "Successful requests served by this account.",
      accLastUsed: "Last used",
      accNever: "never",
      accCooldownLeft: "Cooldown",
      accReserve: "Reserve",
      accReserveHint: "Do not dispatch below this balance; 0 = use the global floor.",
      accReserveSave: "Save",
      accSource: "Origin",
      accSourceDesktop: "desktop sign-in snapshot",
      accSourcePlugin: "plugin import (QR/paste)",
      accSourceShortDesktop: "desktop",
      accSourceShortPlugin: "plugin import",
      accSourceHint: "Desktop snapshots are written by the WorkBuddy app; plugin imports are only read by this plugin.",
      accRefreshTokenYes: "auto-renewable",
      accRefreshTokenNo: "no refresh token",
      accRefreshTokenHint: "With a refresh token, an expired credential is renewed once automatically.",
      accExpires: "Expires",
      accNoExpiry: "no expiry reported",
      accDisable: "Disable",
      accEnable: "Enable",
      accDisableHint: "A disabled account stays in the pool but is never selected.",
      accRemove: "Remove",
      accRemoveConfirm: "Confirm",
      accCancel: "Cancel",
      accRemoveHint: "Removes only plugin-imported credential files; desktop files are never deleted.",
      accLastError: "Last error",
      accErrorShow: "Show error",
      accErrorHide: "Hide error",
      accNoError: "No error recorded.",
      accRegion: "Region",
      accReserveSaved: "Reserve saved",

      reasonRateLimit: "rate limited",
      reasonGateway: "gateway error",
      reasonNeedsSignIn: "credential rejected",
      reasonCredits: "out of credits",
      reasonRestricted: "account restricted",
      reasonManual: "disabled by hand",
      reasonLowCredits: "below usable floor",
      reasonBelowReserve: "below reserve",
      reasonModelCooldown: "some models cooling",
      reasonUnknown: "unknown reason",

      modelsTitle: "Model catalog",
      modelsSub: "Choose which models the DSH picker offers; the catalog comes from this region's upstream account.",
      modelsSubGlobal: "The global catalog comes from its upstream account (/v3/config); without a global account the built-in fallback is shown.",
      modelsSearch: "Search",
      modelsSearchPlaceholder: "Filter by id or name",
      modelsSelected: "enabled",
      modelsDirty: "unsaved changes",
      modelsSave: "Save",
      modelsDiscard: "Discard",
      modelsSelectAll: "Select all",
      modelsClearFilter: "Enable everything",
      modelsAllMode: "All models (not customized)",
      modelsCustomMode: "Custom selection",
      modelsSelectAllHint: "Tick every model; saving equals \"all models\", including future ones.",
      modelsSelectNoneHint: "Clear every tick, then tick what you want; an empty selection cannot be saved (it would mean all models).",
      modelsSelectNone: "Clear all",
      modelsNoneSelected: "No model selected",
      modelsNoneSelectedHint: "Nothing selected: tick at least one model (or use Select all) before saving.",
      modelsEnableAllHint: "Back to all models, including future ones.",
      modelsMatchCount: "matched",
      modelsClearSearch: "Clear search",
      modelsSaveBarHint: "applies immediately, no restart",
      modelsUsage: "samples",
      modelsUsageHint: "From this region's recent requests; low sample counts are indicative only.",
      modelsTps: "tok/s",
      modelsFallback: "built-in list",
      modelsLive: "live catalog",
      modelsFallbackHint: "No successful live fetch yet; the built-in list is shown and replaced once an account responds.",
      modelsLiveHint: "From /v2/enterprises/personal/models (global: /v3/config).",
      modelsContext: "Context",
      modelsContextHint: "Maximum input tokens the model accepts.",
      modelsRate: "Rate",
      modelsRateHint: "Upstream credit multiplier; lower is cheaper. Unknown means the upstream did not publish it.",
      modelsImages: "Images",
      modelsImagesHint: "Whether the model accepts image input.",
      modelsNone: "No model matches.",
      modelsSaved: "Model selection saved",
      modelsSavedAll: "Saved: all models enabled",
      modelsRefresh: "Refresh from upstream",
      modelsRefreshHint: "Pull the model roster from this region's upstream account now; the saved selection is untouched.",
      modelsRefreshed: "Models fetched:",
      modelsRefreshFailed: "Refresh failed",

      reqTitle: "Request log",
      reqSub: "Every call through the pool records account, outcome, queueing and duration, so models can be chosen from data.",
      reqRegion: "Region",
      reqFilterAll: "All",
      reqFilterOk: "Succeeded",
      reqFilterFail: "Failed",
      reqEmptyTitle: "No requests yet",
      reqEmptyBody: "Send one message on a model from this pool and every call shows up here.",
      reqTime: "Time",
      reqModel: "Model",
      reqAccount: "Account",
      reqResult: "Result",
      reqQueue: "Queue",
      reqQueueHint: "Time from joining the pool to the first upstream response header.",
      reqDuration: "Took",
      reqTokens: "in/out",
      reqOk: "ok",
      reqFail: "failed",
      reqKind: "Error kind",
      reqNone: "No matching record.",
      reqKindHint: "The error kind is the upstream attribution: rate limit, dead credential, exhausted credits, request fault, etc.",

      statsTitle: "Per-model stats",
      statsSub: "p50/p95 from the last 200 samples; more samples make it reliable.",
      statsSamples: "Samples",
      statsQueueP50: "queue p50",
      statsTotalP50: "total p50",
      statsTps: "tok/s p50",
      statsEmpty: "Not enough samples yet.",

      autoTitle: "Daily points automation",
      autoSub: "Claims check-in, activity, tasks, streak and buddy-travel rewards for every account on schedule; every task is idempotent and safe to replay.",
      autoEnable: "Enable automation",
      autoEnableHint: "When off, no scheduled request is made. When on, passes run at the hours below and a missed pass runs once after start.",
      autoEarningsTitle: "Automation earnings",
      autoEarningsHint: "Only credits claimed by automation, excluding normal chat usage.",
      autoToday: "Today",
      autoLast7: "7 days",
      autoMonth: "Month",
      autoHours: "Hours",
      autoHoursHint: "Local time, comma separated, e.g. 9,21; empty means never.",
      autoHoursInvalid: "Hours must be integers 0–23 separated by commas.",
      autoNextRun: "Next run",
      autoNoNextRun: "no slot left today",
      autoLastRun: "Last run",
      autoNeverRun: "not run yet",
      autoRunNow: "Run now",
      autoRunHint: "Runs once for every usable account without changing the schedule.",
      autoResults: "Per-account results",
      autoResultOk: "ok",
      autoResultFail: "failed",
      autoJobCheckin: "Daily check-in",
      autoJobReport: "Activity report",
      autoJobTasks: "Task rewards",
      autoJobStreak: "Streak rewards",
      autoJobTravel: "Buddy travel",
      autoJobCompensation: "Outage compensation",
      autoJobCheckinDesc: "Reads the check-in state and claims today's credits; already-checked-in counts as success.",
      autoJobReportDesc: "Sends one activity event and reads the streak back to prove it was not silently dropped.",
      autoJobTasksDesc: "Enrols in open tasks, then claims rewards whose progress is complete.",
      autoJobStreakDesc: "Redeems unlocked streak tiers and spends any lottery chances.",
      autoJobTravelDesc: "Accepts the terms, adopts a buddy, departs, or claims an arrived trip.",
      autoJobCompensationDesc: "Claims the one-off DeepSeek outage compensation; skips itself once claimed or expired.",
      autoDisabledHint: "Automation is off; the buttons below still run a single pass.",
      autoSaved: "Automation settings saved",
      autoRunDone: "Run finished",
      autoRunAll: "Run all now",
      autoRunAllHint: "Runs check-in → report → tasks → streak → travel once for every usable account, in that order; the schedule is unchanged.",
      autoRunAllDone: "All automation passes finished",


      importTitle: "Paste credential",
      importHint: "Paste the whole content of any .info file from the WorkBuddy desktop auth directory (shape {\"auth\":{\"accessToken\":...}}). Encrypted content needs the desktop app; on a pure web host use QR sign-in instead.",
      importPlaceholder: "{\"auth\":{\"accessToken\":\"...\",\"refreshToken\":\"...\",\"domain\":\"www.codebuddy.cn\"}}",
      importSubmit: "Import",
      importAnotherHint: "This dialog stays open: after each import the box clears, so paste the next account's .info and import again.",
      importAdded: "Added",
      importEmpty: "The content is empty.",
      importInvalidJson: "That is not valid JSON.",
      importOk: "Imported",

      qrTitle: "Add a WorkBuddy account by QR",
      qrHint: "Click Start, then scan the QR or open the link on a phone already signed in to WorkBuddy; on confirmation the account is added to the pool. Repeat for more accounts.",
      qrLinkLogin: "Sign in with a link",
      qrLinkLoginHint: "Opens the sign-in page in your browser; the account joins the pool once confirmed",
      qrQrLogin: "Sign in with a QR code",
      qrQrLoginHint: "Shows the QR code here; scan it with your phone to finish signing in",
      qrLinkOpened: "The sign-in page was opened in your browser; the account joins automatically once confirmed",
      qrStarting: "Requesting a sign-in…",
      qrStart: "Start sign-in",
      qrWaiting: "Waiting for confirmation…",
      qrOpen: "Open link",
      qrCopy: "Copy link",
      qrCopied: "link copied",
      qrDone: "Signed in; the account was added",
      qrAnother: "Add another account",
      qrAnotherHint: "This dialog stays open: sign in with another WorkBuddy account to add it too.",
      qrExpired: "Sign-in not completed",
      qrTimeout: "Timed out; start again",
      qrCountdown: "left",
      qrClose: "Close",
      qrRetry: "Start again",

      toastSaved: "Saved",
      toastImported: "Imported",
      toastRescanned: "Accounts rescanned",
      toastCredits: "Credits refreshed",
      toastCooldown: "Cooldowns cleared",
      toastDisable: "Account disabled",
      toastEnable: "Account enabled",
      toastRemoved: "Account removed",
      toastCopied: "Copied to clipboard",
      toastFailed: "Action failed",
      copyFailed: "Copy failed",

      loadErrorTitle: "Status read failed",
      loadErrorBody: "The plugin route returned no status; the host may be reloading. Retry shortly, or check that the plugin is enabled.",
      retry: "Retry",
      footerNote: "Source: /plugins/dsh-workbuddy-pool/status · auto-refresh every 30 s",
      loading: "Reading status…",
    };

    /* ------------------------------------------------------------------ *
     * Styles — Host theme tokens only
     * ------------------------------------------------------------------ */

    const CSS = `
.wbp-root{position:relative;display:flex;flex-direction:column;gap:16px;height:100%;overflow:auto;box-sizing:border-box;padding:20px 24px 48px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.wbp-head{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;justify-content:space-between}
.wbp-title{margin:0;font-size:20px;font-weight:650;letter-spacing:.01em}
.wbp-title-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.wbp-title-row .wbp-title{line-height:1.15}
.wbp-sub{margin:6px 0 0;max-width:680px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.wbp-meta-row{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin-top:10px}
.wbp-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.wbp-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;cursor:pointer;transition:background .15s ease,border-color .15s ease}
.wbp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.wbp-btn:disabled{opacity:.55;cursor:not-allowed}
.wbp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
/**
 * Primary button: the host's semantic PAIR, never a background token.
 *
 * This used to paint the label with --dsw-alias-bg-base, a BACKGROUND token.
 * That only reads by luck: under the stock theme the brand fill is light and the
 * page base is dark. A third-party theme that lightens the page base (or the
 * brand fill the other way) collapses text into the fill, and the label silently
 * disappears -- reported as missing fonts while every other label keeps
 * rendering.
 *
 * The host paints its own primary button with the pair
 * --dsw-alias-button-primary-fill + --dsw-alias-label-primary-foreground
 * (measured in the shipped index-*.css). A theme author has to keep that pair
 * readable against each other, which is exactly the guarantee needed here, so
 * the same pair is used rather than mixing brand-primary with a foreground token
 * of our own choosing. The parenthesised fallback keeps the label readable on a
 * theme that defines neither token.
 *
 * NOTE: this stylesheet lives inside a template literal, so no backticks and no
 * dollar-brace sequences are allowed anywhere in it -- including comments. A
 * backtick here terminates the string and the whole client module fails to
 * parse (which is exactly how 0.4.40 broke the desktop boot).
 */
.wbp-btn--primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-label-primary))}
.wbp-btn--primary:hover:not(:disabled){filter:brightness(1.06);background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
.wbp-btn--ghost{background:transparent}
.wbp-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.wbp-btn--sm{height:26px;padding:0 9px;font-size:11px}
.wbp-spin{width:10px;height:10px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:wbp-spin .7s linear infinite}
@keyframes wbp-spin{to{transform:rotate(360deg)}}
.wbp-seg{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.wbp-seg--fill{display:flex;width:100%}
.wbp-seg--fill .wbp-seg-btn{flex:1 1 0;text-align:center}
.wbp-seg-btn{height:26px;padding:0 12px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer}
.wbp-seg-btn[aria-pressed="true"],.wbp-seg-btn[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.wbp-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wbp-badge{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;border:1px solid transparent;font-size:11px;white-space:nowrap}
.wbp-badge--ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.wbp-badge--warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.wbp-badge--bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.wbp-badge--info{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.wbp-badge--idle{color:var(--dsw-alias-state-idle-primary);border-color:var(--dsw-alias-state-idle-primary)}
.wbp-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
.wbp-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px}
.wbp-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px}
.wbp-stat-k{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.wbp-stat-v{margin-top:4px;font-size:20px;font-weight:650;font-variant-numeric:tabular-nums}
.wbp-stat-h{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.wbp-tabs{display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1)}
.wbp-tab{flex:0 0 auto;padding:8px 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;font-family:inherit;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.wbp-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.wbp-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.wbp-count{font-size:10px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.wbp-cards{display:flex;flex-direction:column;gap:14px}
.wbp-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px}
.wbp-card--tight{padding:14px}
.wbp-card-head{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;justify-content:space-between;margin-bottom:12px}
.wbp-card-title{margin:0;font-size:13px;font-weight:600}
.wbp-card-sub{margin:4px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.55;max-width:720px}
.wbp-card-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.wbp-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.wbp-grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.wbp-account{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);padding:14px 16px;margin:0}
.wbp-accounts{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:12px;align-items:start}
.wbp-account-head{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.wbp-account-id{display:flex;gap:12px;align-items:center;min-width:0}
.wbp-avatar{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--dsw-alias-bg-layer-2);font-size:13px;font-weight:600;flex:0 0 auto}
.wbp-account-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px}
.wbp-acct-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px 12px;margin-top:12px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.wbp-acct-stat-k{font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.wbp-acct-stat-v{margin-top:3px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wbp-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(108px,1fr));gap:10px;margin:12px 0}
.wbp-meta-k{font-size:11px;color:var(--dsw-alias-label-secondary)}
.wbp-meta-v{margin-top:2px;font-size:13px;font-weight:550;font-variant-numeric:tabular-nums}
.wbp-meta-v--muted{font-weight:400;color:var(--dsw-alias-label-secondary);font-size:12px}
.wbp-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.55}
.wbp-hint--warn{color:var(--dsw-alias-state-warn-primary)}
.wbp-hint--ok{color:var(--dsw-alias-state-success-primary)}
.wbp-hint--bad{color:var(--dsw-alias-state-error-primary)}
.wbp-err-box{margin-top:10px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-state-error-primary);max-height:180px;overflow:auto}
.wbp-input{height:28px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit}
.wbp-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wbp-input--w{88px}
.wbp-input--wide{width:200px}
.wbp-input--bare{height:24px;width:64px;padding:0 2px;border:0;background:transparent;text-align:right}
.wbp-input--bare:focus-visible{outline:none}
.wbp-field{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 6px 0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.wbp-field:focus-within{border-color:var(--dsw-alias-brand-primary)}
.wbp-field-label{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.wbp-search{height:28px;min-width:170px}
.wbp-switch{display:inline-flex;align-items:center;gap:8px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;cursor:pointer;padding:0}
.wbp-switch-track{position:relative;width:36px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);transition:background .15s ease,border-color .15s ease}
.wbp-switch-dot{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s ease,background .15s ease}
.wbp-switch[aria-checked="true"] .wbp-switch-track{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary))}
.wbp-switch[aria-checked="true"] .wbp-switch-dot{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-label-primary))}
.wbp-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px;border-radius:6px}
.wbp-model{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;padding:9px 4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.wbp-model:last-child{border-bottom:0}
.wbp-model-main{display:flex;gap:10px;align-items:center;min-width:0;flex:1 1 260px}
.wbp-model-name{font-size:12px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbp-model-id{font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}
.wbp-model-meta{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary)}
.wbp-image-toggle{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.wbp-check{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;flex:0 0 auto}
.wbp-check:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.wbp-tag{font-size:10px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.wbp-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;scrollbar-width:thin}
.wbp-table-wrap--request{max-height:340px}
.wbp-table-wrap::-webkit-scrollbar{width:10px;height:10px}
.wbp-table-wrap::-webkit-scrollbar-track{background:transparent}
.wbp-table-wrap::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:999px;border:2px solid transparent;background-clip:content-box}
.wbp-stats-title{display:block;padding-left:11px}
.wbp-table{width:100%;border-collapse:collapse;font-size:12px}
.wbp-table th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;font-size:11px}
.wbp-table td{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}
.wbp-table tr:last-child td{border-bottom:0}
.wbp-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.wbp-table th.wbp-num,.wbp-table td.wbp-num{text-align:right}
.wbp-mono{font-family:ui-monospace,monospace;font-size:11px}
.wbp-legend{display:flex;flex-wrap:wrap;gap:8px 16px}
.wbp-legend-item{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:help}
.wbp-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:22px;text-align:center}
.wbp-empty h4{margin:0 0 6px;font-size:13px;font-weight:600}
.wbp-empty p{margin:0 auto;max-width:520px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.wbp-empty-actions{display:flex;gap:8px;justify-content:center;margin-top:12px;flex-wrap:wrap}
.wbp-skeleton{border-radius:8px;background:var(--dsw-alias-bg-layer-2);animation:wbp-pulse 1.4s ease-in-out infinite}
@keyframes wbp-pulse{0%,100%{opacity:.55}50%{opacity:.9}}
.wbp-modal{position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:20px;pointer-events:none}
.wbp-modal-card{display:flex;flex-direction:column;width:min(560px,92%);max-height:calc(100% - 32px);overflow:hidden;border:1px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);pointer-events:auto}
.wbp-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.wbp-modal-title{margin:0;font-size:14px;font-weight:600}
.wbp-modal-body{display:flex;flex-direction:column;gap:10px;padding:14px;overflow:auto}
.wbp-modal-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.wbp-choice{display:flex;flex-direction:column;gap:3px;width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;text-align:left;cursor:pointer}
.wbp-choice:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.wbp-choice:disabled{opacity:.55;cursor:not-allowed}
.wbp-choice:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wbp-choice-k{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600}
.wbp-choice-v{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.wbp-choice-h{font-size:11px;color:var(--dsw-alias-label-secondary)}
.wbp-qr-region{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.wbp-qr-region-k{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wbp-qr-panel{display:flex;flex-direction:column;align-items:center;gap:10px;padding-top:2px}
.wbp-qr{display:block;width:220px;height:220px;border-radius:10px;background:var(--dsw-alias-bg-base)}
.wbp-row--center{justify-content:center}
.wbp-hint--center{text-align:center}
.wbp-textarea{width:100%;min-height:150px;box-sizing:border-box;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,monospace;font-size:12px;resize:vertical}
.wbp-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wbp-link{color:var(--dsw-alias-brand-primary);word-break:break-all;font-size:11px}
.wbp-toasts{position:fixed;right:18px;bottom:18px;z-index:70;display:flex;flex-direction:column;gap:8px;max-width:min(380px,90vw)}
.wbp-toast{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:9px 12px;font-size:12px;display:flex;gap:8px;align-items:flex-start}
.wbp-toast--ok{border-color:var(--dsw-alias-state-success-primary)}
.wbp-toast--bad{border-color:var(--dsw-alias-state-error-primary)}
.wbp-toast-text{flex:1 1 auto;line-height:1.5}
.wbp-toast-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1;padding:0}
.wbp-hours-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.wbp-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 4px 1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;font-variant-numeric:tabular-nums}
.wbp-chip-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1;padding:2px 4px;border-radius:999px}
.wbp-chip-x:hover{color:var(--dsw-alias-state-error-primary)}
.wbp-divider{height:1px;background:var(--dsw-alias-border-l1);margin:12px 0}
.wbp-footer{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;align-items:center}
.wbp-strong{color:var(--dsw-alias-label-primary);font-weight:600}
.wbp-account-details{margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.wbp-job{padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.wbp-job:last-child{border-bottom:0}
.wbp-job-head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.wbp-job-name{font-size:12px;font-weight:550}
.wbp-job-results{margin-top:6px;padding:6px 8px;border-left:2px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:2px}
.wbp-savebar{position:sticky;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
@media (max-width:760px){
  .wbp-root{padding:14px 14px 40px}
  .wbp-title{font-size:17px}
  .wbp-stats{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
  .wbp-meta{grid-template-columns:repeat(auto-fit,minmax(92px,1fr))}
  .wbp-acct-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .wbp-account-name{max-width:180px}
  .wbp-table th:nth-child(6),.wbp-table td:nth-child(6){display:none}
  .wbp-toasts{left:14px;right:14px;bottom:14px;max-width:none}
}
@media (prefers-reduced-motion:reduce){
  .wbp-spin,.wbp-skeleton{animation:none}
  .wbp-btn,.wbp-switch-track,.wbp-switch-dot{transition:none}
}
    `;

    /* ------------------------------------------------------------------ *
     * Data helpers
     * ------------------------------------------------------------------ */

    /** One JSON request to the plugin's own routes (same-origin). */
    async function api(path, body) {
      const init =
        body === undefined
          ? { method: "GET" }
          : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) };
      const response = await fetch(path, init);
      const text = await response.text();
      let parsed;
      try {
        parsed = text === "" ? {} : JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok) throw new Error(parsed?.error ?? `HTTP ${response.status}`);
      return parsed;
    }

    /** Copy text, tolerating hosts without the async clipboard API. */
    async function copyText(value) {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(String(value ?? ""));
        return true;
      }
      return false;
    }

    /** Format a duration in milliseconds compactly. */
    function fmtDuration(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
      if (ms < 1_000) return `${Math.round(ms)} ms`;
      if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
      return `${Math.round(ms / 60_000)} min`;
    }

    /** Format an epoch value as local `HH:MM:SS`. */
    function fmtTime(value) {
      if (typeof value !== "number" || value <= 0) return "—";
      const date = new Date(value);
      const pad = (number) => String(number).padStart(2, "0");
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** Format an epoch value as local `MM-DD HH:MM`. */
    function fmtDateTime(value) {
      if (typeof value !== "number" || value <= 0) return "—";
      const date = new Date(value);
      const pad = (number) => String(number).padStart(2, "0");
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** Compact relative age, language-neutral (`12s`, `3m`, `2h`, then a date). */
    function fmtAgo(value, clock) {
      if (typeof value !== "number" || value <= 0) return "—";
      const diff = Math.max(0, clock - value);
      if (diff < 10_000) return "now";
      if (diff < 60_000) return `${Math.round(diff / 1_000)}s`;
      if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
      if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
      return fmtDateTime(value);
    }

    /** Countdown string for a future epoch. */
    function fmtCountdown(until, clock) {
      const ms = until - clock;
      if (!Number.isFinite(ms) || ms <= 0) return "—";
      if (ms < 60_000) return `${Math.ceil(ms / 1_000)}s`;
      if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m`;
      return `${(ms / 3_600_000).toFixed(1)}h`;
    }

    /** The account's first character, for the avatar. */
    function initialOf(label) {
      const text = typeof label === "string" ? label.trim() : "";
      return text === "" ? "?" : String.fromCodePoint(text.codePointAt(0));
    }

    /** Whether a credential file was written by the plugin (safe to remove). */
    function originOf(account) {
      const source = typeof account?.source === "string" ? account.source : "";
      return /[\\/]workbuddy-pool[\\/]credentials[\\/]/u.test(source) ? "plugin" : "desktop";
    }

    /** The file name shown as the source annotation. */
    function sourceFileOf(account) {
      const source = typeof account?.source === "string" ? account.source : "";
      const parts = source.split(/[\\/]/u);
      return parts[parts.length - 1] || "—";
    }

    /** Badge tone for one account state. */
    const STATE_TONE = { ready: "ok", cooling: "warn", blocked: "bad", restricted: "warn", disabled: "bad" };
    /** Dictionary key for one account state. */
    const STATE_KEY = { ready: "stateReady", cooling: "stateCooling", blocked: "stateBlocked", restricted: "stateRestricted", disabled: "stateDisabled" };
    /** Dictionary key for one account reason. */
    const REASON_KEY = {
      "rate-limit": "reasonRateLimit",
      "gateway-error": "reasonGateway",
      "needs-sign-in": "reasonNeedsSignIn",
      "credits-exhausted": "reasonCredits",
      "account-restricted": "reasonRestricted",
      "disabled-manually": "reasonManual",
      "low-credits": "reasonLowCredits",
      "below-reserve": "reasonBelowReserve",
      "model-cooldown": "reasonModelCooldown",
    };

    /** Parse a comma separated hour list into sorted unique integers, or undefined. */
    function parseHours(text) {
      const parts = String(text ?? "")
        .split(/[,，\s]+/u)
        .filter((part) => part !== "");
      const out = [];
      for (const part of parts) {
        if (!/^\d{1,2}$/u.test(part)) return undefined;
        const value = Number(part);
        if (!Number.isInteger(value) || value < 0 || value > 23) return undefined;
        if (!out.includes(value)) out.push(value);
      }
      return out.sort((a, b) => a - b);
    }

    /** Next local occurrence of any listed hour, or undefined. */
    function nextRunOf(hours) {
      if (!Array.isArray(hours) || hours.length === 0) return undefined;
      const now = new Date();
      let best;
      for (const hour of hours) {
        const candidate = new Date(now);
        candidate.setHours(hour, 0, 0, 0);
        if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
        if (best === undefined || candidate.getTime() < best) best = candidate.getTime();
      }
      return best;
    }

    /** The ok/failed summary of one automation run. */
    function runSummary(run) {
      if (run === null || run === undefined) return undefined;
      const results = Array.isArray(run.results) ? run.results : [];
      return {
        ok: results.filter((result) => result.ok === true).length,
        failed: results.filter((result) => result.ok === false).length,
      };
    }

    /* ------------------------------------------------------------------ *
     * Presentation primitives
     * ------------------------------------------------------------------ */

    /** A card with a title, an explanation and optional actions. */
    function Card({ title, sub, actions, children, tight }) {
      return h(
        "section",
        { className: `wbp-card${tight ? " wbp-card--tight" : ""}` },
        h(
          "div",
          { className: "wbp-card-head" },
          h("div", null, h("h3", { className: "wbp-card-title" }, title), sub !== undefined ? h("p", { className: "wbp-card-sub" }, sub) : null),
          actions === undefined ? null : h("div", { className: "wbp-card-actions" }, actions),
        ),
        children,
      );
    }

    /** One stat tile with its explanation and an optional inline badge. */
    function Stat({ label, value, hint, extra }) {
      return h(
        "div",
        { className: "wbp-stat" },
        h("div", { className: "wbp-stat-k" }, h("span", null, label), extra ?? null),
        h("div", { className: "wbp-stat-v" }, value),
        hint !== undefined ? h("div", { className: "wbp-stat-h" }, hint) : null,
      );
    }

    /** A full-width choice row: title on the left, current value on the right. */
    function Choice({ label, value, hint, onClick, disabled, title }) {
      return h(
        "button",
        { type: "button", className: "wbp-choice", title, disabled: disabled === true, onClick },
        h(
          "span",
          { className: "wbp-choice-k" },
          h("span", null, label),
          value === undefined ? null : h("span", { className: "wbp-choice-v" }, value),
        ),
        hint === undefined ? null : h("span", { className: "wbp-choice-h" }, hint),
      );
    }

    /** A status/annotation badge. */
    function Badge({ tone, title, children }) {
      return h("span", { className: `wbp-badge wbp-badge--${tone ?? "idle"}`, title }, h("span", { className: "wbp-dot" }), children);
    }

    /** A button that shows its own pending state. */
    function Button({ variant, busy, disabled, title, onClick, children, small }) {
      return h(
        "button",
        {
          type: "button",
          className: `wbp-btn${variant === undefined ? "" : ` wbp-btn--${variant}`}${small ? " wbp-btn--sm" : ""}`,
          disabled: disabled === true || busy === true,
          "aria-busy": busy === true ? "true" : undefined,
          title,
          onClick,
        },
        busy === true ? h("span", { className: "wbp-spin", "aria-hidden": "true" }) : null,
        children,
      );
    }

    /** A switch with an accessible role. */
    function Switch({ checked, onChange, label, hint, disabled }) {
      return h(
        "div",
        { className: "wbp-row", style: { gap: 10 } },
        h(
          "button",
          {
            type: "button",
            className: "wbp-switch",
            role: "switch",
            "aria-checked": checked === true ? "true" : "false",
            "aria-label": label,
            disabled: disabled === true,
            onClick: () => onChange?.(checked !== true),
          },
          h("span", { className: "wbp-switch-track", "aria-hidden": "true" }, h("span", { className: "wbp-switch-dot" })),
          h("span", null, label),
        ),
        hint !== undefined ? h("span", { className: "wbp-hint" }, hint) : null,
      );
    }

    /** A dismissible toast viewport. */
    function Toasts({ items, onClose }) {
      if (items.length === 0) return null;
      return h(
        "div",
        { className: "wbp-toasts", role: "status", "aria-live": "polite" },
        items.map((item) =>
          h(
            "div",
            { key: item.id, className: `wbp-toast wbp-toast--${item.tone === "bad" ? "bad" : "ok"}` },
            h("span", { className: "wbp-toast-text" }, item.text),
            h("button", { type: "button", className: "wbp-toast-close", "aria-label": "dismiss", onClick: () => onClose(item.id) }, "×"),
          ),
        ),
      );
    }

    /** A modal dialog with Escape support, a scrollable body and a fixed action bar. */
    function Modal({ title, onClose, children, footer, hideClose }) {
      const closeRef = React.useRef(null);
      React.useEffect(() => {
        closeRef.current?.focus?.();
        const onKeyDown = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        };
        if (typeof document !== "undefined") document.addEventListener("keydown", onKeyDown);
        return () => {
          if (typeof document !== "undefined") document.removeEventListener("keydown", onKeyDown);
        };
      }, [onClose]);
      return h(
        "div",
        { className: "wbp-modal" },
        h(
          "div",
          { className: "wbp-modal-card", role: "dialog", "aria-modal": "true", "aria-label": title },
          h(
            "div",
            { className: "wbp-modal-head" },
            h("h3", { className: "wbp-modal-title" }, title),
            hideClose === true
              ? null
              : h("button", { ref: closeRef, type: "button", className: "wbp-btn wbp-btn--ghost wbp-btn--sm", "aria-label": "close", onClick: onClose }, "×"),
          ),
          h("div", { className: "wbp-modal-body" }, children),
          footer === undefined ? null : h("div", { className: "wbp-modal-actions" }, footer),
        ),
      );
    }

    /** Loading skeleton for the first paint. */
    function LoadingCards() {
      return h(
        "div",
        { className: "wbp-cards", "aria-busy": "true" },
        h("div", { className: "wbp-stats" }, [0, 1, 2, 3, 4].map((index) => h("div", { key: index, className: "wbp-skeleton", style: { height: 74 } }))),
        h("div", { className: "wbp-skeleton", style: { height: 180 } }),
      );
    }

    /** Static legend explaining every account state. */
    function StateLegend({ t }) {
      const rows = [
        ["ready", "success"],
        ["cooling", "warn"],
        ["blocked", "error"],
        ["restricted", "warn"],
        ["disabled", "error"],
      ];
      return h(
        "div",
        { className: "wbp-legend" },
        rows.map(([state, tone]) =>
          h(
            "span",
            { key: state, className: "wbp-legend-item", title: t(`${STATE_KEY[state]}Hint`) },
            h("span", { className: "wbp-dot", style: { color: `var(--dsw-alias-state-${tone}-primary)` } }),
            t(STATE_KEY[state]),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Account card
     * ------------------------------------------------------------------ */

    /** One labelled value in the account card's always-visible stat strip. */
    function AccountStat({ label, value, hint }) {
      return h(
        "div",
        { className: "wbp-acct-stat", title: hint },
        h("div", { className: "wbp-acct-stat-k" }, label),
        h("div", { className: "wbp-acct-stat-v" }, value),
      );
    }

    function AccountCard({ account, t, clock, pending, onDisable, onReserve, onRemove }) {
      const [detailsOpen, setDetailsOpen] = React.useState(false);
      const [reserveText, setReserveText] = React.useState(String(account.reserve ?? 0));
      const [confirmRemove, setConfirmRemove] = React.useState(false);
      React.useEffect(() => {
        setReserveText(String(account.reserve ?? 0));
      }, [account.reserve]);
      const tone = STATE_TONE[account.state] ?? "idle";
      const reasonKey = REASON_KEY[account.reason];
      const origin = originOf(account);
      const removable = origin === "plugin";
      const reserveValue = Number(reserveText);
      const reserveDirty = Number.isFinite(reserveValue) && reserveValue >= 0 && reserveValue !== (account.reserve ?? 0);
      const lastError = account.lastError;
      const cooldown = account.cooldownUntil && account.cooldownUntil > clock ? fmtCountdown(account.cooldownUntil, clock) : undefined;
      return h(
        "article",
        { className: "wbp-account" },
        h(
          "div",
          { className: "wbp-account-head" },
          h(
            "div",
            { className: "wbp-account-id" },
            h("span", { className: "wbp-avatar", "aria-hidden": "true" }, initialOf(account.label)),
            h(
              "div",
              { className: "wbp-row", style: { gap: 10, minWidth: 0 } },
              h("div", { className: "wbp-account-name", title: account.label }, account.label),
              h(Badge, { tone: "info", title: t("accSourceHint") }, origin === "plugin" ? t("accSourceShortPlugin") : t("accSourceShortDesktop")),
              h(Badge, { tone: "idle", title: t("accRegion") }, account.region === "global" ? t("regionGlobal") : t("regionCn")),
            ),
          ),
          // The state sits on the same row, pushed to the card's right edge.
          h(
            "div",
            { className: "wbp-row", style: { gap: 8, marginLeft: "auto", justifyContent: "flex-end" } },
            cooldown === undefined ? null : h(Badge, { tone: "warn", title: t("accCooldownLeft") }, `${t("accCooldownLeft")} ${cooldown}`),
            h(Badge, { tone, title: reasonKey === undefined ? undefined : t(reasonKey) }, t(STATE_KEY[account.state] ?? "reasonUnknown")),
          ),
        ),
        // The four numbers that decide "can it serve now", said once, in one row.
        h(
          "div",
          { className: "wbp-acct-stats" },
          h(AccountStat, { label: t("accCredits"), value: typeof account.credits === "number" ? String(account.credits) : t("accCreditsUnknown"), hint: t("accCreditsHint") }),
          h(AccountStat, { label: t("accInFlight"), value: String(account.inFlight ?? 0), hint: t("accInFlightHint") }),
          h(AccountStat, { label: t("accRequests"), value: String(account.requests ?? 0), hint: t("accRequestsHint") }),
          h(AccountStat, { label: t("accLastUsed"), value: account.lastUsedAt ? fmtAgo(account.lastUsedAt, clock) : t("accNever"), hint: t("accLastUsed") }),
        ),
        lastError !== null && lastError !== undefined
          ? h("p", { className: "wbp-hint wbp-hint--bad", style: { marginTop: 8 } }, t("accLastError"))
          : null,
        h(
          "div",
          { className: "wbp-row", style: { marginTop: 14, justifyContent: "space-between" } },
          h(
            "div",
            { className: "wbp-row" },
            h(
              "button",
              { type: "button", className: "wbp-btn wbp-btn--ghost wbp-btn--sm", "aria-expanded": detailsOpen === true, onClick: () => setDetailsOpen((open) => !open) },
              detailsOpen ? t("accDetailsHide") : t("accDetails"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "wbp-btn wbp-btn--sm",
                disabled: pending === true,
                title: t("accDisableHint"),
                onClick: () => onDisable(account.disabled !== true),
              },
              account.disabled === true ? t("accEnable") : t("accDisable"),
            ),
            // Removal and the reserve floor both act on the account itself, so
            // they live in this always-visible row instead of inside details.
            removable
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "wbp-btn wbp-btn--danger wbp-btn--sm",
                    disabled: pending === true,
                    title: t("accRemoveHint"),
                    onClick: () => (confirmRemove ? onRemove() : setConfirmRemove(true)),
                  },
                  confirmRemove ? t("accRemoveConfirm") : t("accRemove"),
                )
              : null,
            confirmRemove
              ? h("button", { type: "button", className: "wbp-btn wbp-btn--ghost wbp-btn--sm", onClick: () => setConfirmRemove(false) }, t("accCancel"))
              : null,
          ),
          // The reserve floor is a secondary knob: keep it on the row's right edge.
          h(
            "div",
            { className: "wbp-field", title: t("accReserveHint") },
            h("span", { className: "wbp-field-label" }, t("accReserve")),
            h("input", {
              className: "wbp-input wbp-input--bare",
              type: "number",
              min: 0,
              value: reserveText,
              "aria-label": t("accReserve"),
              onChange: (event) => setReserveText(event.target.value),
            }),
            h(
              "button",
              { type: "button", className: "wbp-btn wbp-btn--ghost wbp-btn--sm", disabled: !reserveDirty || pending === true, onClick: () => onReserve(reserveValue) },
              t("accReserveSave"),
            ),
          ),
        ),
        detailsOpen
          ? h(
              "div",
              { className: "wbp-account-details" },
              h(
                "div",
                { className: "wbp-meta" },
                h(
                  "div",
                  { title: t("accCreditsHint") },
                  h("div", { className: "wbp-meta-k" }, t("accBalanceReadAt")),
                  h("div", { className: "wbp-meta-v wbp-meta-v--muted" }, account.creditsAt ? fmtAgo(account.creditsAt, clock) : "—"),
                ),
                h(
                  "div",
                  { title: t("accRefreshTokenHint") },
                  h("div", { className: "wbp-meta-k" }, "Token"),
                  h("div", { className: "wbp-meta-v wbp-meta-v--muted" }, account.hasRefreshToken ? t("accRefreshTokenYes") : t("accRefreshTokenNo")),
                ),
                h(
                  "div",
                  { title: t("accExpires") },
                  h("div", { className: "wbp-meta-k" }, t("accExpires")),
                  h("div", { className: "wbp-meta-v wbp-meta-v--muted" }, account.expiresAt ? fmtDateTime(account.expiresAt) : t("accNoExpiry")),
                ),
                h(
                  "div",
                  { title: t("accSourceHint") },
                  h("div", { className: "wbp-meta-k" }, t("accSource")),
                  h("div", { className: "wbp-meta-v wbp-meta-v--muted wbp-mono" }, sourceFileOf(account)),
                ),
              ),
              lastError !== null && lastError !== undefined
                ? h(
                    "div",
                    { className: "wbp-err-box" },
                    `${fmtDateTime(lastError.at)} · ${lastError.kind ?? "error"}${lastError.status !== undefined ? ` · HTTP ${lastError.status}` : ""}\n${String(lastError.message ?? "")}`,
                  )
                : null,
            )
          : null,
      );
    }

    /* ------------------------------------------------------------------ *
     * Panel
     * ------------------------------------------------------------------ */

    function Panel(props) {
      const t = props.t ?? ((key) => zh[key] ?? key);
      /**
       * Three top-level views. The two pool views are per region; the settings
       * view owns model selection and request details for BOTH regions, so it
       * loads and shows both statuses at once.
       */
      const [view, setView] = React.useState("cn");
      const [statuses, setStatuses] = React.useState({});
      const [loadError, setLoadError] = React.useState(undefined);
      const [loading, setLoading] = React.useState(true);
      const [lastUpdated, setLastUpdated] = React.useState(0);
      const [clock, setClock] = React.useState(Date.now());
      const [pending, setPending] = React.useState({});
      const [toasts, setToasts] = React.useState([]);
      const toastSeq = React.useRef(0);
      const toastTimers = React.useRef([]);
      const [modal, setModal] = React.useState(null);
      const [importText, setImportText] = React.useState("");
      const [importError, setImportError] = React.useState(undefined);
      const [qr, setQr] = React.useState(undefined);
      const [importSaved, setImportSaved] = React.useState(undefined);
      const qrTimer = React.useRef(undefined);
      const [modelSearch, setModelSearch] = React.useState({ cn: "", global: "" });
      const [requestFilter, setRequestFilter] = React.useState("all");
      const [modelDrafts, setModelDrafts] = React.useState({ cn: undefined, global: undefined });
      const [imageDrafts, setImageDrafts] = React.useState({ cn: undefined, global: undefined });
      const [hoursDraft, setHoursDraft] = React.useState({});
      const [settingsTab, setSettingsTab] = React.useState("models");
      const [modelRegion, setModelRegion] = React.useState("cn");
      const [runAllProgress, setRunAllProgress] = React.useState(undefined);
      const [confirmRunAll, setConfirmRunAll] = React.useState(false);

      /** The region whose pool the two pool views show; settings shows both. */
      const region = view === "global" ? "global" : "cn";
      const status = statuses[region];

      const pushToast = React.useCallback((tone, text) => {
        toastSeq.current += 1;
        const id = toastSeq.current;
        setToasts((list) => [...list, { id, tone, text }]);
        const timer = setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), TOAST_MS);
        toastTimers.current.push(timer);
      }, []);

      React.useEffect(
        () => () => {
          for (const timer of toastTimers.current) clearTimeout(timer);
          if (qrTimer.current !== undefined) clearTimeout(qrTimer.current);
        },
        [],
      );

      React.useEffect(() => {
        const timer = setInterval(() => setClock(Date.now()), 1_000);
        return () => clearInterval(timer);
      }, []);

      const refresh = React.useCallback(
        async (options = {}) => {
          if (options.silent !== true) setLoading(true);
          const targets = view === "settings" ? ["cn", "global"] : [view];
          try {
            const entries = await Promise.all(targets.map(async (key) => [key, await api(`${ROUTES.status}?region=${key}`)]));
            setStatuses((previous) => {
              const next = { ...previous };
              for (const [key, payload] of entries) next[key] = payload;
              return next;
            });
            setLoadError(undefined);
            setLastUpdated(Date.now());
          } catch (error) {
            setLoadError(String(error?.message ?? error));
            if (options.silent !== true) setStatuses({});
          } finally {
            setLoading(false);
          }
        },
        [view],
      );

      React.useEffect(() => {
        void refresh({ silent: false });
      }, [refresh]);

      React.useEffect(() => {
        // Auto refresh is always on; the timer pauses itself while hidden.
        const timer = setInterval(() => {
          if (typeof document !== "undefined" && document.hidden) return;
          void refresh({ silent: true });
        }, POLL_MS);
        return () => clearInterval(timer);
      }, [refresh]);

      /** Run one action with its own pending flag and a toast on failure. */
      const act = React.useCallback(
        async (key, action, success) => {
          setPending((state) => ({ ...state, [key]: true }));
          try {
            const result = await action();
            if (success !== undefined) pushToast("ok", success);
            await refresh({ silent: true });
            return result;
          } catch (error) {
            pushToast("bad", `${t("toastFailed")}: ${String(error?.message ?? error)}`);
            return undefined;
          } finally {
            setPending((state) => {
              const next = { ...state };
              delete next[key];
              return next;
            });
          }
        },
        [pushToast, refresh, t],
      );

      /** Stop the QR poll loop; a reopened dialog must never inherit it. */
      const stopQrPolling = React.useCallback(() => {
        if (qrTimer.current !== undefined) {
          clearTimeout(qrTimer.current);
          qrTimer.current = undefined;
        }
      }, []);

      /**
       * Adding an account is a repeatable action, so every entry point opens a
       * FRESH dialog. Reusing the previous `qr` record is what made a second
       * account impossible before: a finished sign-in left the dialog in its
       * "done" phase, which renders neither the start button nor the retry one.
       */
      const openAddQr = React.useCallback(() => {
        stopQrPolling();
        setQr(undefined);
        setModal("qr");
      }, [stopQrPolling]);

      /** The paste dialog also starts clean, so the next document can follow at once. */
      const openAddImport = React.useCallback(() => {
        setImportText("");
        setImportError(undefined);
        setImportSaved(undefined);
        setModal("import");
      }, []);

      const closeAddDialog = React.useCallback(() => {
        stopQrPolling();
        setModal(null);
      }, [stopQrPolling]);

      const pool = status?.pool;
      const catalog = status?.catalog;
      const automation = status?.automation ?? statuses.cn?.automation ?? statuses.global?.automation;
      const accounts = pool?.accounts ?? [];
      const creditsTotal = accounts.reduce((sum, account) => sum + (typeof account.credits === "number" ? account.credits : 0), 0);
      const credentialWarn = (status?.scan?.warnings ?? []).includes("desktop-app-required");
      /** Full catalog for one region (unfiltered by the saved selection). */
      const rosterOf = (key) => statuses[key]?.catalog?.roster ?? statuses[key]?.catalog?.models ?? [];

      /**
       * Canonical selection ids: an empty list means "every model, including
       * future ones". Ids that are no longer in the roster are dropped, and
       * ticking every visible model also collapses to the empty list so the
       * saved value keeps the same meaning however it was produced.
       */
      const canonicalIds = (list, rosterIds) => {
        const known = [...new Set((Array.isArray(list) ? list : []).filter((id) => rosterIds.includes(id)))];
        if (known.length === 0 || rosterIds.every((id) => known.includes(id))) return [];
        return known.sort();
      };

      /** Model-selection state for one region (settings page). */
      const selectionState = (key) => {
        const regionStatus = statuses[key];
        const stored = regionStatus?.settings?.modelSelection?.[key] ?? {};
        const storedIds = Array.isArray(stored.enabledModelIds) ? stored.enabledModelIds : [];
        const rosterIds = rosterOf(key).map((model) => model.id);
        const storedCanonical = canonicalIds(storedIds, rosterIds);
        const draft = modelDrafts[key];
        // An empty draft means "the user just unticked everything" — a transient
        // state used to re-pick, not a savable selection. An empty SAVED list is
        // different: the backend reads it as "all models", and registering a
        // provider with zero models would break the picker.
        const draftNone = draft !== undefined && draft.length === 0;
        const draftCanonical = draft === undefined || draftNone ? undefined : canonicalIds(draft, rosterIds);
        const ids = draftNone === true ? [] : draftCanonical ?? storedCanonical;
        const all = draftNone !== true && ids.length === 0;
        const selected = all ? undefined : new Set(ids);
        const dirty = draftNone === true || (draftCanonical !== undefined && draftCanonical.join("\u0000") !== storedCanonical.join("\u0000"));
        return {
          stored,
          storedIds,
          draft,
          draftNone,
          draftCanonical,
          ids,
          all,
          selected,
          dirty,
          saveable: draftNone !== true && dirty,
          rosterIds,
          enabledCount: all ? rosterIds.length : ids.filter((id) => rosterIds.includes(id)).length,
        };
      };

      /** Toggle one model in one region's draft selection. */
      const toggleModelFor = (key, id) => {        const { selected, rosterIds } = selectionState(key);
        const base = selected === undefined ? new Set(rosterIds) : new Set(selected);
        if (base.has(id)) base.delete(id);
        else base.add(id);
        setModelDrafts((previous) => ({ ...previous, [key]: [...base] }));
      };

      /**
       * Per-model image capability for one region.
       *
       * The card's checkboxes start from the saved override when there is one,
       * otherwise from what the upstream catalog advertises; editing writes a
       * draft that is submitted with the model selection.
       */
      const imageInfoOf = (key) => {
        const stored = statuses[key]?.settings?.modelSelection?.[key]?.imageModelIds;
        const base = Array.isArray(stored) ? stored : rosterOf(key).filter((model) => model.supportsImages === true).map((model) => model.id);
        const draft = imageDrafts[key];
        const ids = draft === undefined ? base : draft;
        return {
          enabled: new Set(ids),
          ids,
          base,
          draft,
          dirty: draft !== undefined && draft.join("\u0000") !== base.join("\u0000"),
        };
      };

      /** Toggle one model's image support in the draft. */
      const toggleImageFor = (key, id) => {
        const info = imageInfoOf(key);
        const next = new Set(info.ids);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setImageDrafts((previous) => ({ ...previous, [key]: [...next] }));
      };

      /** Compact token counts for the model rows (1M / 200K). */
      const fmtTokens = (value) => {
        if (typeof value !== "number" || Number.isFinite(value) === false) return "—";
        if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1)).toString()}M`;
        if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
        return String(value);
      };

      // What automation actually earned today. The ledger split (earningsByKind
      // + rewardsToday) is authoritative because it survives a later idempotent
      // pass that reclaims nothing; older hosts only expose per-run credits, so
      // fall back to the last run's numbers.
      const automationEarnings = automation?.earnings ?? { today: 0, last7: 0, month: 0 };
      const ledgerByKind = automation?.earningsByKind ?? {};
      const hasLedgerSplit = Object.keys(ledgerByKind).length > 0;
      const automationRewards = typeof automation?.rewardsToday === "number"
        ? automation.rewardsToday
        : AUTOMATION_KINDS.reduce((count, kind) => {
            const results = automation?.runs?.[kind]?.results ?? [];
            return count + results.filter((result) => result.ok === true && typeof result.credit === "number" && result.credit > 0).length;
          }, 0);
      const automationBreakdown = AUTOMATION_KINDS.filter((kind) => !CAMPAIGN_KINDS.has(kind) || automation?.campaign?.open !== false).map((kind) => {
        const credit = hasLedgerSplit ? (ledgerByKind[kind] ?? 0) : (automation?.runs?.[kind]?.credit ?? 0);
        return credit > 0 ? `${t(AUTOMATION_LABEL_KEY[kind])} +${credit}` : undefined;
      })
        .filter((entry) => entry !== undefined)
        .join(" · ");

      const nextRefreshed = lastUpdated === 0 ? t("neverUpdated") : fmtAgo(lastUpdated, clock);

      /* -------------------- header -------------------- */

      const version = statuses.cn?.plugin?.version ?? statuses.global?.plugin?.version ?? "—";

      // The header keeps identity + live status only; every action now lives
      // inside the region page where its effect is visible.
      const header = h(
        "div",
        { className: "wbp-head" },
        h(
          "div",
          null,
          h(
            "div",
            { className: "wbp-title-row" },
            h("h1", { className: "wbp-title" }, t("title")),
            h(Badge, { tone: "info", title: t("versionLabel") }, `${t("versionLabel")} ${version}`),
            h("span", { className: "wbp-hint" }, `${t("lastUpdated")}: ${nextRefreshed}`),
          ),
          h("p", { className: "wbp-sub" }, t("subtitle")),
        ),
      );

      /* -------------------- region + stats -------------------- */

      const regionSwitch = h(
        "div",
        { className: "wbp-row" },
        h(
          "div",
          { className: "wbp-seg wbp-seg--fill", role: "group", "aria-label": t("regionHint") },
          ...[
            ["cn", t("regionCn"), t("regionCnHint")],
            ["global", t("regionGlobal"), t("regionGlobalHint")],
            ["settings", t("settingsTab"), t("settingsHint")],
          ].map(([key, label, hint]) => {
            const summary = key === "settings" ? undefined : statuses[key]?.regions?.[key];
            return h(
              "button",
              { key, type: "button", className: "wbp-seg-btn", "aria-pressed": view === key ? "true" : "false", title: hint, onClick: () => setView(key) },
              key === "settings" ? `⚙ ${label}` : `${label}${summary === undefined ? "" : ` ${summary.available}/${summary.total}`}`,
            );
          }),
        ),
      );

      // Pool state first, automation gains last.
      const stats = h(
        "div",
        { className: "wbp-stats" },
        h(Stat, { label: t("statAccounts"), value: `${pool?.available ?? "—"} / ${pool?.total ?? "—"}`, hint: t("statAccountsHint") }),
        h(Stat, { label: t("statCredits"), value: accounts.some((account) => typeof account.credits === "number") ? creditsTotal : "—", hint: t("statCreditsHint") }),
        h(Stat, { label: t("statUsage"), value: String(pool?.usage?.today?.requests ?? 0), hint: `${pool?.usage?.today?.input ?? 0} in / ${pool?.usage?.today?.output ?? 0} out` }),
        h(Stat, {
          label: t("statAutoResult"),
          value: `+${automationEarnings.today}`,
          hint: `${automationRewards} ${t("autoRewardUnit")}${automationBreakdown === "" ? "" : ` · ${automationBreakdown}`} · ${t("autoLast7")} +${automationEarnings.last7} · ${t("autoMonth")} +${automationEarnings.month}`,
          extra: h(
            Badge,
            { tone: automation?.enabled === true ? "ok" : "bad", title: t("statAutomationHint") },
            automation?.enabled === true ? t("stateOn") : t("stateOff"),
          ),
        }),
      );

      /* -------------------- accounts tab -------------------- */

      const accountsEmpty =
        accounts.length === 0
          ? h(
              "div",
              { className: "wbp-empty" },
              h("h4", null, t("accountsEmptyTitle")),
              h("p", null, t("accountsEmptyBody")),
              credentialWarn ? h("p", { className: "wbp-hint wbp-hint--warn", style: { marginTop: 8 } }, t("scanWarnEncrypted")) : null,
              h(
                "div",
                { className: "wbp-empty-actions" },
                h(Button, { variant: "primary", onClick: () => openAddQr() }, t("actionQr")),
                h(Button, { onClick: () => openAddImport() }, t("actionImport")),
              ),
            )
          : null;

      const accountsTab = h(
        "div",
        { className: "wbp-cards" },
        h(
          Card,
          {
            title: t("accountsTitle"),
            sub: t("accountsSub"),
            // Add-account actions belong on the account pool itself.
            actions: [
              h(Button, { key: "qr", variant: "primary", title: t("actionQrHint"), onClick: () => openAddQr() }, t("actionQr")),
              h(Button, { key: "import", variant: "primary", title: t("actionImportHint"), onClick: () => openAddImport() }, t("actionImport")),
              h(Button, { key: "rescan", title: t("actionRescanHint"), busy: pending["rescan"] === true, onClick: () => act("rescan", () => api(ROUTES.rescan, {}), t("toastRescanned")) }, t("actionRescan")),
            ],
          },
          [
            // Maintenance actions sit next to the pool state they act on.
            h(
              "div",
              { className: "wbp-row", style: { marginBottom: 10, justifyContent: "space-between" } },
              h(
                "div",
                { className: "wbp-row", style: { gap: 8 } },
                h(Button, { variant: "ghost", busy: loading === true, title: t("refreshHint"), onClick: () => refresh({ silent: false }) }, t("refresh")),
                h(Button, { variant: "ghost", title: t("actionCreditsHint"), busy: pending["credits"] === true, onClick: () => act("credits", () => api(ROUTES.refreshCredits, {}), t("toastCredits")) }, t("actionCredits")),
                h(Button, { variant: "ghost", title: t("actionCooldownHint"), busy: pending["cooldown"] === true, onClick: () => act("cooldown", () => api(ROUTES.resetCooldowns, {}), t("toastCooldown")) }, t("actionCooldown")),
              ),
              h(
                "span",
                { className: "wbp-hint" },
                `${t("scanAt")}: ${status?.scan?.at ? fmtDateTime(status.scan.at) : "—"}${(status?.scan?.warnings ?? []).length > 0 ? ` · ${status.scan.warnings.join(", ")}` : ""}`,
              ),
            ),
            accountsEmpty,
            // Wide screens pair the cards up instead of leaving one long row.
            h(
              "div",
              { className: "wbp-accounts" },
              accounts.map((account) =>
                h(AccountCard, {
                  key: account.id,
                  account,
                  t,
                  clock,
                  pending: pending[`acc:${account.id}`] === true,
                  onDisable: (disabled) =>
                    act(`acc:${account.id}`, () => api(ROUTES.disableAccount, { id: account.id, disabled }), disabled ? t("toastDisable") : t("toastEnable")),
                  onReserve: (reserve) => act(`acc:${account.id}`, () => api(ROUTES.reserveAccount, { id: account.id, reserve }), t("accReserveSaved")),
                  onRemove: () => act(`acc:${account.id}`, () => api(ROUTES.removeAccount, { id: account.id }), t("toastRemoved")),
                }),
              ),
            ),
            // The legend explains the badge colours, so it stays visible instead
            // of hiding behind a toggle.
            h(
              "div",
              { style: { marginTop: 14 } },
              h("div", { className: "wbp-hint", style: { marginBottom: 6 }, title: t("legendHint") }, t("legendTitle")),
              h(StateLegend, { t }),
            ),
          ],
        ),
      );

      /* -------------------- settings: model selection -------------------- */

      const regionLabelOf = (key) => (key === "global" ? t("regionGlobal") : t("regionCn"));

      /** One region's model-selection card (settings page). */
      const renderModelSection = (key) => {
        const regionStatus = statuses[key];
        const regionCatalog = regionStatus?.catalog;
        const roster = rosterOf(key);
        const { selected, dirty, all, enabledCount, rosterIds, draftNone } = selectionState(key);
        const imageInfo = imageInfoOf(key);
        const anyDirty = dirty === true || imageInfo.dirty === true;
        const statById = new Map((regionStatus?.pool?.stats ?? []).map((stat) => [stat.id, stat]));
        const query = (modelSearch[key] ?? "").trim().toLowerCase();
        const visible = roster.filter((model) => {
          if (query === "") return true;
          return [model.id, model.name, model.displayName ?? "", ...(model.tags ?? [])].some((value) => String(value).toLowerCase().includes(query));
        });
        const selectAll = () => setModelDrafts((previous) => ({ ...previous, [key]: [...rosterIds] }));
        const selectNone = () => setModelDrafts((previous) => ({ ...previous, [key]: [] }));
        const discard = () => {
          setModelDrafts((previous) => ({ ...previous, [key]: undefined }));
          setImageDrafts((previous) => ({ ...previous, [key]: undefined }));
        };
        const save = async () => {
          const state = selectionState(key);
          const image = imageInfoOf(key);
          if (state.draftNone === true) return;
          if (state.draftCanonical === undefined && image.draft === undefined) return;
          const payload = {
            region: key,
            ...(state.draftCanonical === undefined ? {} : { enabledModelIds: state.draftCanonical }),
            ...(image.draft === undefined ? {} : { imageModelIds: image.draft }),
          };
          const result = await act(`models:${key}`, () => api(ROUTES.saveModels, payload), state.draftCanonical !== undefined && state.draftCanonical.length === 0 ? t("modelsSavedAll") : t("modelsSaved"));
          if (result !== undefined) discard();
        };
        return h(
          Card,
          {
            key,
            title: t("settingsModelsTitle"),
            sub: key === "global" ? t("modelsSubGlobal") : t("modelsSub"),
            actions: [
              h(
                "div",
                { key: "region", className: "wbp-seg", role: "group", "aria-label": t("regionHint") },
                ...[
                  ["cn", t("regionCn")],
                  ["global", t("regionGlobal")],
                ].map(([regionKey, label]) =>
                  h(
                    "button",
                    { key: regionKey, type: "button", className: "wbp-seg-btn", "aria-pressed": key === regionKey ? "true" : "false", onClick: () => setModelRegion(regionKey) },
                    label,
                  ),
                ),
              ),
              h("input", {
                key: "search",
                className: "wbp-input wbp-search",
                type: "search",
                placeholder: t("modelsSearchPlaceholder"),
                "aria-label": `${t("modelsSearch")} ${regionLabelOf(key)}`,
                value: modelSearch[key] ?? "",
                onChange: (event) => setModelSearch((previous) => ({ ...previous, [key]: event.target.value })),
              }),
              // Manual pull: replaces a stale roster without waiting for the timer.
              h(
                Button,
                {
                  key: "refresh",
                  busy: pending[`models-refresh:${key}`] === true,
                  title: t("modelsRefreshHint"),
                  onClick: async () => {
                    const result = await act(`models-refresh:${key}`, () => api(ROUTES.refreshModels, { region: key }), undefined);
                    if (result === undefined) return;
                    pushToast(result.ok === true ? "ok" : "bad", result.ok === true ? `${t("modelsRefreshed")} ${result.count}` : `${t("modelsRefreshFailed")}: ${result.error ?? "—"}`);
                  },
                },
                t("modelsRefresh"),
              ),
            ],
          },
          [
            h(
              "div",
              { className: "wbp-row", style: { justifyContent: "space-between", marginBottom: 8, gap: 10 } },
              h(
                "div",
                { className: "wbp-row", style: { gap: 8 } },
                h(Badge, { tone: regionCatalog?.fallback ? "warn" : "ok", title: regionCatalog?.fallback ? t("modelsFallbackHint") : t("modelsLiveHint") }, regionCatalog?.fallback ? t("modelsFallback") : t("modelsLive")),
                h(
                  Badge,
                  { tone: draftNone === true ? "warn" : "info", title: all ? t("modelsSub") : t("modelsCustomMode") },
                  draftNone === true ? t("modelsNoneSelected") : all ? t("modelsAllMode") : `${t("modelsCustomMode")} ${enabledCount}/${roster.length}`,
                ),
                h("span", { className: "wbp-hint" }, `${enabledCount} ${t("modelsSelected")} / ${roster.length}`),
                h("button", { type: "button", className: "wbp-btn wbp-btn--ghost wbp-btn--sm", title: t("modelsSelectAllHint"), onClick: selectAll }, t("modelsSelectAll")),
                h("button", { type: "button", className: "wbp-btn wbp-btn--ghost wbp-btn--sm", title: t("modelsSelectNoneHint"), onClick: selectNone }, t("modelsSelectNone")),
              ),
              regionCatalog?.error
                ? h("span", { className: "wbp-hint wbp-hint--bad" }, String(regionCatalog.error))
                : query === ""
                  ? null
                  : h("span", { className: "wbp-hint" }, `${t("modelsMatchCount")} ${visible.length}/${roster.length}`),
            ),
            regionStatus === undefined
              ? h("p", { className: "wbp-hint" }, t("loading"))
              : visible.length === 0
                ? h(
                    "div",
                    { className: "wbp-empty" },
                    h("p", null, t("modelsNone")),
                    query === "" ? null : h(Button, { variant: "ghost", onClick: () => setModelSearch((previous) => ({ ...previous, [key]: "" })) }, t("modelsClearSearch")),
                  )
                : visible.map((model) => {
                    const checked = selected === undefined ? true : selected.has(model.id);
                    const stat = statById.get(model.id);
                    return h(
                      "div",
                      { key: model.id, className: "wbp-model" },
                      h(
                        "div",
                        { className: "wbp-model-main" },
                        h("input", { className: "wbp-check", type: "checkbox", checked, "aria-label": `${regionLabelOf(key)} ${model.id}`, onChange: () => toggleModelFor(key, model.id) }),
                        h(
                          "div",
                          { style: { minWidth: 0 } },
                          h("div", { className: "wbp-model-name", title: model.displayName ?? model.name }, model.displayName ?? model.name),
                          h("div", { className: "wbp-model-id" }, model.id),
                        ),
                      ),
                      h(
                        "div",
                        { className: "wbp-model-meta" },
                        h("span", { title: t("modelsContextHint") }, `${t("modelsContext")}: ${fmtTokens(model.contextWindow)}`),
                        h("span", { title: t("modelsRateHint") }, `${t("modelsRate")}: ${model.multiplier === null || model.multiplier === undefined ? "—" : `x${model.multiplier}`}`),
                        // Only models the upstream catalog reports as image-capable
                        // get a switch; ticking a text-only model would be a lie.
                        model.supportsImages === true
                          ? h(
                              "label",
                              { className: "wbp-image-toggle", title: t("modelsImagesHint") },
                              h("input", {
                                className: "wbp-check",
                                type: "checkbox",
                                checked: imageInfo.enabled.has(model.id),
                                "aria-label": `${t("modelsImages")} ${model.id}`,
                                onChange: () => toggleImageFor(key, model.id),
                              }),
                              h("span", null, t("modelsImages")),
                            )
                          : null,
                        ...(model.tags ?? []).map((tag) => h("span", { key: tag, className: "wbp-tag" }, String(tag))),
                        stat === undefined || (stat.samples ?? 0) === 0
                          ? null
                          : h("span", { title: t("modelsUsageHint") }, `${t("modelsUsage")}: ${stat.samples} · ${typeof stat.tpsP50 === "number" ? stat.tpsP50.toFixed(0) : "—"} ${t("modelsTps")}`),
                      ),
                    );
                  }),
            anyDirty
              ? h(
                  "div",
                  { className: "wbp-savebar" },
                  h(
                    "span",
                    { className: draftNone === true ? "wbp-hint wbp-hint--warn" : "wbp-hint" },
                    draftNone === true ? t("modelsNoneSelectedHint") : `${enabledCount} ${t("modelsSelected")} · ${t("modelsSaveBarHint")}`,
                  ),
                  h(
                    "div",
                    { className: "wbp-row" },
                    h(Button, { variant: "primary", disabled: draftNone === true, busy: pending[`models:${key}`] === true, onClick: () => void save() }, t("modelsSave")),
                    h(Button, { variant: "ghost", onClick: discard }, t("modelsDiscard")),
                  ),
                )
              : null,
          ],
        );
      };

      /* -------------------- settings: request details -------------------- */

      const mergedRequests = [];
      for (const key of ["cn", "global"]) {
        for (const record of statuses[key]?.pool?.requests ?? []) mergedRequests.push({ ...record, region: key });
      }
      mergedRequests.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      const filteredRequests = mergedRequests.filter((record) => (requestFilter === "all" ? true : requestFilter === "ok" ? record.ok === true : record.ok !== true));

      const mergedStats = [];
      for (const key of ["cn", "global"]) {
        for (const stat of statuses[key]?.pool?.stats ?? []) mergedStats.push({ ...stat, region: key });
      }

      // Requests page: one card. The per-model stats table lives inside the same
      // card behind a toggle instead of being a second card.
      const requestsSection = h(
        Card,
        {
          title: t("reqTitle"),
          sub: t("settingsRequestsSub"),
          actions: [
            h(
              "div",
              { key: "filter", className: "wbp-seg", role: "group", "aria-label": t("reqResult") },
              ...[
                ["all", t("reqFilterAll")],
                ["ok", t("reqFilterOk")],
                ["fail", t("reqFilterFail")],
              ].map(([key, label]) =>
                h("button", { key, type: "button", className: "wbp-seg-btn", "aria-pressed": requestFilter === key ? "true" : "false", onClick: () => setRequestFilter(key) }, label),
              ),
            ),
            h(Badge, { key: "count", tone: "info" }, String(filteredRequests.length)),
          ],
        },
        [
          filteredRequests.length === 0
            ? h("div", { className: "wbp-empty" }, h("h4", null, t("reqEmptyTitle")), h("p", null, t("reqEmptyBody")))
            : h(
                "div",
                { className: "wbp-table-wrap wbp-table-wrap--request" },
                h(
                  "table",
                  { className: "wbp-table" },
                  h(
                    "thead",
                    null,
                    h(
                      "tr",
                      null,
                      h("th", null, t("reqRegion")),
                      h("th", null, t("reqTime")),
                      h("th", null, t("reqModel")),
                      h("th", null, t("reqResult")),
                      h("th", { className: "wbp-num" }, t("reqDuration")),
                    ),
                  ),
                  h(
                    "tbody",
                    null,
                    filteredRequests.map((record, index) =>
                      h(
                        "tr",
                        { key: `${record.region}-${record.at ?? index}-${index}` },
                        h("td", null, h(Badge, { tone: "info" }, regionLabelOf(record.region))),
                        h("td", { className: "wbp-mono", title: record.label ?? record.account ?? "" }, fmtTime(record.at)),
                        h("td", { className: "wbp-mono", title: record.model ?? "" }, record.model ?? "—"),
                        h(
                          "td",
                          null,
                          h(
                            Badge,
                            { tone: record.ok ? "ok" : "bad", title: `${t("reqKindHint")}${record.kind ? ` (${record.kind})` : ""}` },
                            record.ok ? t("reqOk") : `${t("reqFail")}${record.kind ? ` · ${record.kind}` : ""}`,
                          ),
                        ),
                        h(
                          "td",
                          { className: "wbp-num", title: `${t("reqQueue")}: ${fmtDuration(record.queueMs)} · ${t("reqTokensHint")}: ${record.inputTokens ?? 0}/${record.outputTokens ?? 0}` },
                          fmtDuration(record.totalMs),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          h("div", { className: "wbp-divider" }),
          h("span", { className: "wbp-meta-k wbp-stats-title" }, t("statsTitle")),
          mergedStats.length === 0
            ? h("div", { className: "wbp-empty" }, h("p", null, t("statsEmpty")))
            : h(
                  "div",
                  { className: "wbp-table-wrap" },
                  h(
                    "table",
                    { className: "wbp-table" },
                    h(
                      "thead",
                      null,
                      h(
                        "tr",
                        null,
                        h("th", null, t("reqRegion")),
                        h("th", null, t("reqModel")),
                        h("th", { className: "wbp-num" }, t("statsSamples")),
                        h("th", { className: "wbp-num" }, t("statsQueueP50")),
                        h("th", { className: "wbp-num" }, t("statsTotalP50")),
                        h("th", { className: "wbp-num" }, t("statsTps")),
                      ),
                    ),
                    h(
                      "tbody",
                      null,
                      mergedStats.map((stat) =>
                        h(
                          "tr",
                          { key: `${stat.region}-${stat.id}` },
                          h("td", null, h(Badge, { tone: "info" }, regionLabelOf(stat.region))),
                          h("td", { className: "wbp-mono" }, stat.id),
                          h("td", { className: "wbp-num" }, stat.samples ?? 0),
                          h("td", { className: "wbp-num" }, fmtDuration(stat.queueP50)),
                          h("td", { className: "wbp-num" }, fmtDuration(stat.totalP50)),
                          h("td", { className: "wbp-num" }, typeof stat.tpsP50 === "number" ? stat.tpsP50.toFixed(0) : "—"),
                        ),
                      ),
                    ),
                  ),
                ),
        ],
      );

      /**
       * Kind list for this render.
       *
       * The server owns the campaign window (`automation.campaign.open`); the
       * card just honours it, so a client left open across the deadline stops
       * offering the row on the next poll instead of needing a reload.
       */
      const campaignOpen = automation?.campaign?.open !== false;
      const visibleKinds = AUTOMATION_KINDS.filter((kind) => !CAMPAIGN_KINDS.has(kind) || campaignOpen);

      /** Run every visible automation job once, sequentially, for one manual action. */
      const runAllAutomation = React.useCallback(async () => {
        setConfirmRunAll(false);
        setPending((state) => ({ ...state, "job:all": true }));
        setRunAllProgress(0);
        let failed = 0;
        try {
          for (let index = 0; index < visibleKinds.length; index += 1) {
            setRunAllProgress(index + 1);
            try {
              await api(ROUTES.automationRun, { kind: visibleKinds[index] });
            } catch {
              failed += 1;
            }
          }
          await refresh({ silent: true });
          pushToast(failed === 0 ? "ok" : "bad", failed === 0 ? t("autoRunAllDone") : `${t("autoRunAllDone")} · ${failed} failed`);
        } finally {
          setRunAllProgress(undefined);
          setPending((state) => {
            const next = { ...state };
            delete next["job:all"];
            return next;
          });
        }
      }, [pushToast, refresh, t, visibleKinds]);

      const jobRows = [
        ["checkin", t("autoJobCheckin"), t("autoJobCheckinDesc")],
        ["report", t("autoJobReport"), t("autoJobReportDesc")],
        ["tasks", t("autoJobTasks"), t("autoJobTasksDesc")],
        ["streak", t("autoJobStreak"), t("autoJobStreakDesc")],
        ["travel", t("autoJobTravel"), t("autoJobTravelDesc")],
        ["compensation", t("autoJobCompensation"), t("autoJobCompensationDesc")],
      ].filter(([kind]) => visibleKinds.includes(kind));

      /** One card: the master switch, earnings, and a compact row per job. */
      const automationSection = h(
        Card,
        {
          title: t("autoTitle"),
          sub: t("autoSub"),
          actions: [
            h(Switch, {
              key: "enable",
              checked: automation?.enabled === true,
              label: t("autoEnable"),
              disabled: pending["auto"] === true,
              onChange: (enabled) => act("auto", () => api(ROUTES.automationConfig, { enabled }), t("autoSaved")),
            }),
            h(
              Button,
              { key: "run-all", variant: "primary", busy: pending["job:all"] === true, title: t("autoRunAllHint"), onClick: () => setConfirmRunAll(true) },
              pending["job:all"] === true && runAllProgress !== undefined
                ? `${t("runAllProgress")} ${runAllProgress}/${visibleKinds.length}`
                : t("autoRunAll"),
            ),
          ],
        },
        [
          h(
            "div",
            { className: "wbp-row", style: { gap: 18, justifyContent: "space-between" } },
            h(
              "div",
              { className: "wbp-row", style: { gap: 18 } },
              h("span", { className: "wbp-hint", title: t("autoEarningsHint") }, `${t("autoEarningsTitle")} · ${t("autoToday")}: +${automation?.earnings?.today ?? 0} · ${t("autoLast7")}: +${automation?.earnings?.last7 ?? 0} · ${t("autoMonth")}: +${automation?.earnings?.month ?? 0}`),
            ),
            h("span", { className: "wbp-hint" }, automation?.enabled === true ? t("autoEnableHint") : t("autoDisabledHint")),
          ),
          h("div", { className: "wbp-divider" }),
          ...jobRows.map(([kind, label, description]) => {
            const run = automation?.runs?.[kind];
            const hours = automation?.hours?.[kind] ?? [];
            const draftText = hoursDraft[kind] ?? hours.join(",");
            const parsed = parseHours(draftText);
            const hoursDirty = parsed !== undefined && parsed.join(",") !== hours.join(",");
            const next = nextRunOf(hours);
            const summary = runSummary(run);
            return h(
              "div",
              { key: kind, className: "wbp-job" },
              h(
                "div",
                { className: "wbp-job-head" },
                h(
                  "div",
                  { style: { minWidth: 0 } },
                  h("div", { className: "wbp-job-name", title: description }, label),
                  h(
                    "div",
                    { className: "wbp-row", style: { gap: 10, marginTop: 2 } },
                    h("span", { className: "wbp-hint" }, `${t("autoNextRun")}: ${next === undefined ? t("autoNoNextRun") : fmtDateTime(next)}`),
                    h(
                      "span",
                      { className: "wbp-hint" },
                      run === null || run === undefined ? t("autoNeverRun") : `${t("autoLastRun")}: ${fmtDateTime(run.at)} · +${run.credit ?? 0}${summary === undefined ? "" : ` · ${summary.ok}✓/${summary.failed}✗`}`,
                    ),
                  ),
                ),
                h(
                  Button,
                  {
                    small: true,
                    variant: "primary",
                    busy: pending[`job:${kind}`] === true,
                    title: t("autoRunHint"),
                    onClick: () => act(`job:${kind}`, () => api(ROUTES.automationRun, { kind }), t("autoRunDone")),
                  },
                  t("autoRunNow"),
                ),
              ),
              h(
                "div",
                { className: "wbp-row", style: { marginTop: 6, gap: 8 } },
                hours.map((hour) =>
                  h(
                    "span",
                    { key: hour, className: "wbp-chip" },
                    `${String(hour).padStart(2, "0")}:00`,
                    h(
                      "button",
                      {
                        type: "button",
                        className: "wbp-chip-x",
                        "aria-label": `remove ${hour}`,
                        onClick: () => {
                          const nextHours = hours.filter((value) => value !== hour);
                          setHoursDraft((draft) => ({ ...draft, [kind]: nextHours.join(",") }));
                          void act(`hours:${kind}`, () => api(ROUTES.automationConfig, { hours: { [kind]: nextHours } }), t("autoSaved"));
                        },
                      },
                      "×",
                    ),
                  ),
                ),
                h("input", {
                  className: "wbp-input wbp-input--wide",
                  value: draftText,
                  "aria-label": t("autoHours"),
                  placeholder: "9,21",
                  onChange: (event) => setHoursDraft((draft) => ({ ...draft, [kind]: event.target.value })),
                }),
                h(
                  Button,
                  {
                    small: true,
                    disabled: !hoursDirty || parsed === undefined,
                    busy: pending[`hours:${kind}`] === true,
                    onClick: () => {
                      if (parsed === undefined) return;
                      void act(`hours:${kind}`, () => api(ROUTES.automationConfig, { hours: { [kind]: parsed } }), t("autoSaved"));
                      setHoursDraft((draft) => {
                        const nextDraft = { ...draft };
                        delete nextDraft[kind];
                        return nextDraft;
                      });
                    },
                  },
                  t("modelsSave"),
                ),
                parsed === undefined ? h("span", { className: "wbp-hint wbp-hint--bad" }, t("autoHoursInvalid")) : h("span", { className: "wbp-hint", title: t("autoHoursHint") }, t("autoHours")),
              ),
              run !== null && run !== undefined && Array.isArray(run.results) && run.results.length > 0
                ? h(
                    "div",
                    { className: "wbp-job-results" },
                    h("div", { className: "wbp-meta-k" }, t("autoResults")),
                    run.results.map((result, index) => {
                      const credit = typeof result.credit === "number" && result.credit > 0 ? result.credit : undefined;
                      return h(
                        "div",
                        { key: `${result.account ?? index}`, className: "wbp-row", style: { justifyContent: "space-between", gap: 10, padding: "2px 0" } },
                        h("span", { className: "wbp-hint" }, result.label ?? result.account ?? "—"),
                        h("span", { className: "wbp-hint" }, String(result.detail ?? result.status ?? "")),
                        h(
                          "div",
                          { className: "wbp-row", style: { gap: 8 } },
                          credit === undefined ? null : h(Badge, { tone: "ok" }, `+${credit}`),
                          h(Badge, { tone: result.ok ? "ok" : "bad" }, result.ok ? t("autoResultOk") : t("autoResultFail")),
                        ),
                      );
                    }),
                  )
                : null,
            );
          }),
        ],
      );

      /* -------------------- settings view -------------------- */

      /** Settings page: a horizontal row of the three pages, then exactly one
       *  card with the selected page's content. */
      const settingsTabBar = h(
        "div",
        { className: "wbp-row" },
        h(
          "div",
          { className: "wbp-seg wbp-seg--fill", role: "tablist", "aria-label": t("settingsTitle") },
          ...[
            ["models", t("settingsNavModels")],
            ["requests", t("settingsNavRequests")],
            ["automation", t("settingsNavAutomation")],
          ].map(([key, label]) =>
            h(
              "button",
              { key, type: "button", role: "tab", className: "wbp-seg-btn", "aria-selected": settingsTab === key ? "true" : "false", onClick: () => setSettingsTab(key) },
              label,
            ),
          ),
        ),
      );

      const settingsPage = h(
        "div",
        null,
        settingsTab === "models"
          ? renderModelSection(modelRegion)
          : settingsTab === "requests"
            ? requestsSection
            : automationSection,
      );

      /* -------------------- modals -------------------- */

      const importModal =
        modal === "import"
          ? h(
              Modal,
              {
                title: t("importTitle"),
                onClose: closeAddDialog,
                hideClose: true,
                footer: [
                  h(Button, { key: "cancel", onClick: closeAddDialog }, t("qrClose")),
                  h(
                    Button,
                    {
                      key: "submit",
                      variant: "primary",
                      busy: pending["import"] === true,
                      onClick: async () => {
                        const text = importText.trim();
                        if (text === "") return setImportError(t("importEmpty"));
                        try {
                          JSON.parse(text);
                        } catch {
                          return setImportError(t("importInvalidJson"));
                        }
                        const result = await act("import", () => api(ROUTES.importAccount, { document: text }), t("importOk"));
                        if (result !== undefined) {
                          // Stay open: adding one account is usually followed by
                          // adding the next one, so the dialog keeps accepting
                          // documents instead of swallowing the next paste.
                          setImportSaved({ label: result.label });
                          setImportText("");
                          setImportError(undefined);
                        }
                      },
                    },
                    t("importSubmit"),
                  ),
                ],
              },
              [
                h("p", { className: "wbp-hint" }, t("importHint")),
                h("p", { className: "wbp-hint" }, t("importAnotherHint")),
                h("textarea", {
                  key: "ta",
                  className: "wbp-textarea",
                  value: importText,
                  placeholder: t("importPlaceholder"),
                  "aria-label": t("importTitle"),
                  onChange: (event) => {
                    setImportText(event.target.value);
                    setImportError(undefined);
                  },
                }),
                importSaved !== undefined ? h("p", { className: "wbp-hint wbp-hint--ok" }, `${t("importAdded")} · ${importSaved.label}`) : null,
                importError !== undefined ? h("p", { className: "wbp-hint wbp-hint--bad" }, importError) : null,
              ],
            )
          : null;

      const qrRemaining = qr?.deadline === undefined ? undefined : Math.max(0, qr.deadline - clock);

      const qrModal =
        modal === "qr"
          ? h(
              Modal,
              {
                title: t("qrTitle"),
                onClose: closeAddDialog,
                hideClose: true,
                footer: [
                  qr?.phase === "done"
                    ? h(
                        Button,
                        {
                          key: "another",
                          variant: "primary",
                          onClick: () => {
                            // Back to the choices: the dialog stays usable for as
                            // many accounts as the user signs in.
                            setQr(undefined);
                          },
                        },
                        t("qrAnother"),
                      )
                    : null,
                  // Close sits at the action bar's right edge.
                  h(Button, { key: "close", onClick: closeAddDialog }, t("qrClose")),
                ],
              },
              [
                // The sign-in region follows the account tab this dialog was
                // opened from, so there is no separate region switch here.
                h(Choice, {
                  label: t("qrLinkLogin"),
                  hint: t("qrLinkLoginHint"),
                  disabled: qr?.phase === "waiting" || qr?.phase === "starting",
                  onClick: () => startQr("link"),
                }),
                h(Choice, {
                  label: t("qrQrLogin"),
                  hint: t("qrQrLoginHint"),
                  disabled: qr?.phase === "waiting" || qr?.phase === "starting",
                  onClick: () => startQr("qr"),
                }),
                qr?.phase === "waiting" && qr?.authUrl !== undefined && safeAuthUrl(qr.authUrl) !== undefined
                  ? h(
                      "div",
                      { className: "wbp-qr-panel" },
                      qr.mode === "qr" ? h("img", { className: "wbp-qr", src: `${ROUTES.qr}?url=${encodeURIComponent(qr.authUrl)}`, alt: t("qrQrLogin"), width: 220, height: 220 }) : null,
                      h("p", { className: "wbp-hint wbp-hint--center" }, qr.mode === "qr" ? t("qrWaiting") : t("qrLinkOpened")),
                      // The link actions only make sense for link sign-in; the QR
                      // path is completed by the phone, so it shows just the code.
                      qr.mode === "link"
                        ? h(
                            "div",
                            { className: "wbp-row wbp-row--center" },
                            h("a", { className: "wbp-btn", href: safeAuthUrl(qr.authUrl), target: "_blank", rel: "noreferrer noopener" }, t("qrOpen")),
                            h(
                              Button,
                              {
                                onClick: async () => {
                                  const ok = await copyText(safeAuthUrl(qr.authUrl));
                                  pushToast(ok ? "ok" : "bad", ok ? t("qrCopied") : t("copyFailed"));
                                },
                              },
                              t("qrCopy"),
                            ),
                          )
                        : null,
                      qrRemaining !== undefined ? h("p", { className: "wbp-hint wbp-hint--center" }, `${t("qrCountdown")} ${Math.ceil(qrRemaining / 1_000)}s`) : null,
                    )
                  : null,
                qr?.phase === "starting" ? h("p", { className: "wbp-hint wbp-hint--center" }, t("qrStarting")) : null,
                qr?.phase === "done" ? h("p", { className: "wbp-hint wbp-hint--ok wbp-hint--center" }, `${t("qrDone")}${qr.label ? ` · ${qr.label}` : ""}`) : null,
                qr?.phase === "done" ? h("p", { className: "wbp-hint wbp-hint--center" }, t("qrAnotherHint")) : null,
                qr?.phase === "expired" ? h("p", { className: "wbp-hint wbp-hint--bad wbp-hint--center" }, `${t("qrExpired")}${qr.message ? ` · ${qr.message}` : ""}`) : null,
                qr?.phase === "timeout" ? h("p", { className: "wbp-hint wbp-hint--bad wbp-hint--center" }, t("qrTimeout")) : null,
                qr?.phase === "expired" || qr?.phase === "timeout" ? h("div", { className: "wbp-row wbp-row--center" }, h(Button, { variant: "primary", onClick: () => startQr(qr.mode ?? "qr") }, t("qrRetry"))) : null,
              ],
            )
          : null;

      /** Start one sign-in (link or QR) and poll until it settles. */
      function startQr(mode = "qr") {
        stopQrPolling();
        setQr({ phase: "starting", mode });
        void (async () => {
          try {
            const started = await api(ROUTES.oauthStart, { region });
            const deadline = Date.now() + QR_DEADLINE_MS;
            setQr({ phase: "waiting", mode, authUrl: started.authUrl, state: started.state, deadline });
            // Link mode opens the gateway page in the system browser; if the
            // window is blocked the dialog still shows the link button.
            if (mode === "link" && typeof window !== "undefined" && typeof window.open === "function") {
              const url = safeAuthUrl(started.authUrl);
              if (url !== undefined) {
                try {
                  window.open(url, "_blank", "noopener,noreferrer");
                } catch {
                  /* the visible link button stays as the fallback */
                }
              }
            }
            const poll = async () => {
              if (Date.now() > deadline) {
                setQr((state) => ({ ...state, phase: "timeout" }));
                return;
              }
              try {
                const outcome = await api(`${ROUTES.oauthPoll}?state=${encodeURIComponent(started.state)}&region=${region}`);
                if (outcome.status === "pending") {
                  qrTimer.current = setTimeout(() => void poll(), QR_POLL_MS);
                  return;
                }
                if (outcome.status === "ok") {
                  setQr({ phase: "done", mode, label: outcome.label });
                  pushToast("ok", t("toastImported"));
                  await refresh({ silent: true });
                  return;
                }
                setQr((state) => ({ ...state, phase: "expired", message: outcome.message }));
              } catch (error) {
                setQr((state) => ({ ...state, phase: "expired", message: String(error?.message ?? error) }));
              }
            };
            qrTimer.current = setTimeout(() => void poll(), 1_200);
          } catch (error) {
            setQr({ phase: "expired", message: String(error?.message ?? error) });
          }
        })();
      }

      /* -------------------- frame -------------------- */

      // Model selection and request details live on the settings view, so the
      // two pool views only carry the tabs that are per-account / per-runtime.
      const errorCard = h(
        Card,
        { title: t("loadErrorTitle"), sub: t("loadErrorBody") },
        [
          h("p", { className: "wbp-hint wbp-hint--bad" }, loadError ?? "—"),
          h("div", { className: "wbp-row", style: { marginTop: 10 } }, h(Button, { variant: "primary", onClick: () => void refresh({ silent: false }) }, t("retry"))),
        ],
      );

      const body =
        view === "settings"
          ? statuses.cn === undefined && statuses.global === undefined
            ? loadError !== undefined
              ? errorCard
              : h(LoadingCards)
            : h(
                "div",
                null,
                loadError !== undefined ? h("div", { className: "wbp-hint wbp-hint--warn", style: { marginBottom: 8 } }, `${t("toastFailed")}: ${loadError}`) : null,
                settingsPage,
              )
          : status === undefined
            ? loadError !== undefined
              ? errorCard
              : h(LoadingCards)
            : h(
                "div",
                null,
                loadError !== undefined ? h("div", { className: "wbp-hint wbp-hint--warn", style: { marginBottom: 8 } }, `${t("toastFailed")}: ${loadError}`) : null,
                accountsTab,
              );

      return h(
        "div",
        { className: "wbp-root" },
        h("style", null, CSS),
        header,
        regionSwitch,
        view === "settings" ? settingsTabBar : null,
        view === "settings" ? null : stats,
        body,
        h("div", { className: "wbp-footer" }, h("span", null, t("footerNote")), h("span", null, t("regionHint"))),
        importModal,
        qrModal,
        confirmRunAll === true
          ? h(
              Modal,
              {
                title: t("runAllTitle"),
                onClose: () => setConfirmRunAll(false),
                hideClose: true,
                footer: [
                  h(Button, { key: "cancel", onClick: () => setConfirmRunAll(false) }, t("accCancel")),
                  h(Button, { key: "run", variant: "primary", onClick: () => void runAllAutomation() }, t("runAllGo")),
                ],
              },
              [h("p", { className: "wbp-hint" }, t("runAllConfirm"))],
            )
          : null,
        h(Toasts, { items: toasts, onClose: (id) => setToasts((list) => list.filter((item) => item.id !== id)) }),
      );
    }

    /** Render only an https sign-in URL as a link. */
    function safeAuthUrl(value) {
      if (typeof value !== "string") return undefined;
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" ? parsed.href : undefined;
      } catch {
        return undefined;
      }
    }

    /** Sidebar artwork: the monochrome WorkBuddy mark, inlined so the slot needs no host route. */
    const ICON_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAALjElEQVR42uVbbWwU1Rp+zsywLaXS7i5piUT64SXYYJBSrdo/KJiY+k+UixhtNCb6o3KjwYhoIzEkbH9IQirBmJgAYv2hgjUmjSZWvURJ2+vVovwgQNHEpo1YsqVLt/sxM8/90TlzZ/Zzpi2yxpOcLFtmzp73Oe/H877nHOBv3oTfF0gq1nuixGQhAAohzEUHgKQAoAAwhRAs5RX1O1fhZcWdqJJsBLABwD8ABB3j8DpqabGxowAuAhgRQlzKN/f5oKlKVEk+TnKA5CxLt82S/IrkDksTbBl8awBJTQihk2wB0AOgzfHfhmEYNE0TQghomlYq/swp7GkA/xJC/FfK4mflNevzcceKp0nqJE3DMFywZ36/gc205qg7NOJxp0x+1H6HY2A5INPpNElydHSUb7zxBj///PNSAyFrziQf82IOMsSB5B0kEyQNq7uE7+/vZ0NDA8PhMG+++WZ+9NFHc7+o66UGgpx/guQGp4x5ASCpkhx2qL1L+JMnT3Lp0qUMBoNsaGhgXV0dGxsbee7cuVIFQcowbMmmFLP7f2YKL4UaGBhgeXk5y8vLGQwGGQqFuGrVKoZCIW7dupWmadJyjqUKwva8/sCh/qcczsQW/vz58wwGgwRATdMYCARYWVnJ6upq1tbWsqKigh9//LFLW0rMH5gk/53TDBzC15NMSo9qmiZ1XefMzAzXr19PAFRVlZJ2qqrK8vJyVlVVsaKigi0tLYzH4zRNs9S0QE4mSbI+CwSH+j8qETNN017Jp556yl55KbyDe1PTNN50000EwKNHj5ayFpDko1lm4ABg9/993pwAvb29eYV3dqkZGzZsYCqVKkUtkCvyilPmTI9YbdE8qKqKsbExPP/881AUBaZZmFLLd0ZGRtDf3w8hBAzDKMV8qcr5RckTESCEwM6dOxGNRiGEKAqAs/X09MwNrih/jaKAwwQiUl0++eSTLKfnpQshqKoqz5w5U2q8QJpAJK8JmKYJ0zQxOzuLXbt2QQgB0l+Wq6oqDMPAkSNHbG0q5eYCIJFIQFEU9PT04NKlS1BV1ZfqS18AAB9++CGuXbvm+lvJA1BRUYHR0VF0d3dDUZR5TZwkVFXF+Pg4vvjiC2iaBlVVQRK6rvsG9E9pmzZt0gCgvb09YsXztFVOmlcXQlAIwYaGBnZ3d/Onn35yB2RdvxHZY04fIJv8ErEESM9X+Hwcoa2tjW+99RYnJiZuFBDFAVBVNWKt/KIAoChKFoFasWIFOzs7+fPPP7uA+BNIk3cNcAIgw5qmaa6uqioVRfEVGp0hNRAI8Omnn+b58+eZmXWWBACKonjiAFI4P/7BqRWVlZXs6upiLBa73tqQEwDhAEAHEBFCvKIoim4YhgYAoVAILS0tWLduHWpqaqCqKqampnDhwgX8+OOPGB0dnatICuErcmQ+39TUhAMHDqC9vd3mJIvMJHVLzm4hxJ7MQqntA6QG3HnnnTx69Ch///33/DXo2VkODAxw27ZtLofn1TRyaURnZydnZmauR0ZZ2ASEEAAQWb58Od9555200zsbhsF0Ou3qmfZ66tQpbtmyxRZE0zT6CaWKotjANTc3204yFwgy0zQMg7quU9f1rPnJOTrkyA/A3r17NSEE2tvbIxaHT8t6QKEwJQsmTjB6e3u5Zs2arDTZa5faUFVVxU8//dQGIR/wnqohcz4lvw9wbIJEALySTqd1TdOkVnimwNKuY7EYDh48iDfffBPT09MQQvjKKGU+AQCHDh1CZ2dn9l5YNIo//vgDly9fxuTkJKLRKJLJJGKxGIQQqK6uRk1NDdavX4/6+vrCPkCiYRhGxFrxeRufc4UuXLjAJ5980qUNXs3CaRIvvfQSjxw5whdeeIEPPfQQb7/9dq5YsYJLlixxjV1WVsZly5YxGAyytraWq1ev5m233caDBw8WNoFc6fCCCnCOcpqsJre1tfn2D5JSF2OZZWVlrKysZDgc5sqVK7lq1SrW1dVx7dq1rK+v55YtW2gYRvF0eNE26az9QtM0YRgGNm/ejG+//RbvvvsuVq9eDV3X7aSpWGIln9M0zU6sFEWxzcowDCSTScTjcUxPTyMWiyEejyMej+PatWuYmZlBOBzOG1Kva8lGURSXPT/zzDP44YcfsHv3blRUVMAwDCiKUjTeG4YBXdeh6zoMw4BpmjY4zlqGrutIJBKIx+NIJBLQdR1Xr15FQ0MDCm6x+zUBZ9jxw9qcZnH27Flu3bp1Xv7BKztdtmwZFUXhZ599tng+IFdY9ANCpn/o7+/nxo0bs8LgYiRiAFhTU8MrV654K4kVa5KeDg0NYd++fTh06BCuXLniq3SW6R/a29sxODiInp4erFy5Erqu26FwoeYHAA8++CBCoRDS6TQWZAIyvB0/ftyF9Jo1azg+Pm4zs4WEzYmJCe7cudPWgoWYhdSAr7/+2r3R4dEEUplqbxgGL1++bO8PBgIBlpeXEwBfe+21BXH3TLMYHh7m5s2bPYfCXKFRCMHm5mabDi8oDJKEoijYu3cvotEoNE1DKpWCrutQVRW//PLLooRNWTe86667MDAwgAMHDtim4IeVyjm/+OKLdmG3YKQpZAJSRUdGRqhpGhVFsVdE8vxjx44tavbmzC/6+voYCARcv1tM9YUQXLt2LZPJpHO73n8UkMkOST7wwAMuoeVnc3OznTQtdiEjmZzbqP7ggw88J1bymRybtP4BkMKfOHEi59a408lcr3KWBOG5554rCoJc/aampszV9w+AzLkTiQTXrVvnKn3Jz23btvkW3llb8PKedMCTk5MMh8MFnaKc18mTJ3OZpD8AZEg7d+6c7Y2dLGvp0qW8ePGir/CXy0S8mI0UZM+ePXnJkhR+06ZN+WqL/jWAJKPRKEOhkB36AoEAAbCrq8uX45MgjY2N8fXXX+ezzz7Lvr4+T0fspDBnz57NyQ2EEHb6PDw8nE8r5+8DDh8+7PrBe++9l7FYzPPGhlTj8fFx1tXVucbav39/UTOS5qjrOpuamlxEx7n6HR0dhcaaXy4gNWFoaIj79+/nsWPHmEgkfOUAckIdHR0EwLKyMi5ZsoSKojAYDHJqaqqoJsgxtm/fnmUG8t/d3d1ZpKoYAJnHxaZykRTTNNHa2orW1tasQxReSmWqqmJwcBDHjx+HqqpIJpP2uzJ9raqqKkpsAKC2tjbvM2NjY17mNJVrQ0S20VyHqGX9Xk5CVVVPwsvnSWLXrl2uhEmOeffdd6O2thby4LUX1pivFTm0LTJkdAEgq5XfA0gBCFjqJZyFSr/NMAxomob3338fp0+fdhVHJAiRSMQGw8tGSKGsLhQKFbpNolqyfe+UWbFQNa3LBb8CGLReMBd47AaqquLq1at49dVXXSmzBKKjowP33HOPbSZeVl7mHbnS71AolC8tNy2ZhoQQvzovUig5ymOHF+MGiCyTv/322/jtt9/spEQCsXz5cuzbt8+TL5FgxuNxnDlzxq5NZLZAIJBvLKnNhwqWAh2Hpf+z0Oqw9MSPPPKIvbsMwC5lRyIRzzxC8oAvv/wyKwQ6v99yyy2cmJjIJGfeDktnHJndkOu4/HwA6OrqyiJRjY2NnJ2d9ZxAyRD48MMP52WC8m8vv/yy8/edx+XvKHpcPuPCxGOOc7a+NUEKNzk5ydbWVnui4XDYVwIlnxkcHHRtluQrgmzcuJGZbJbkDk8XJrxemfG5J8dkMsm+vj6+9957HBsb83XDRAJw3333FcwGLXps1tTU6NPT02nrN/xfmckBQgvJ73IcPE576VYpytV1Xff0biqVSpNMnzhxIg0grapq2jq9ktUVRdGlH7Dad6lUqmVewue5NreDc1fS/tRrc+l0mrfeequd8BTaCwAw29TU9JW16gu7Nufz4uSiN13XoWkaent78cQTT2SRqHwXJwH4ujj5l7g662ffYdGvzt7oy9PffPMN7r//fs+XpxfKYP927X9CyI9yXTqZLgAAAABJRU5ErkJggg==";

    /** The sidebar icon. */
    function PoolIcon() {
      return h("img", {
        src: ICON_PNG,
        width: 18,
        height: 18,
        alt: "",
        "aria-hidden": "true",
        style: { display: "block", width: 18, height: 18, borderRadius: 4 },
      });
    }

    /** Error boundary: a broken card must not blank the whole application. */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: undefined };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      render() {
        if (this.state.error !== undefined) {
          return h(
            "div",
            { className: "wbp-root" },
            h("style", null, CSS),
            h("div", { className: "wbp-card" }, h("h3", { className: "wbp-card-title" }, "WorkBuddy Pool"), h("div", { className: "wbp-err-box" }, String(this.state.error?.message ?? this.state.error))),
          );
        }
        return this.props.children;
      }
    }

    /** Register the page, its sidebar icon, and the dictionaries. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "workbuddy-pool: dictionaries");
      const t = ctx.locale.bind(NS);
      ctx.slots.inject("main", () =>
        ctx.slots.inject("sidebar.panellist", () => {
          const stopPanel = ctx.slots.register(
            { name: "main", key: PANEL_ID, locale: NS, inject: () => ({ t }) },
            () => h(PanelBoundary, null, h(Panel, { t })),
          );
          let stopIcon;
          try {
            stopIcon = ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 120, label: () => t("nav"), locale: NS }, PoolIcon);
          } catch (iconError) {
            stopPanel();
            throw iconError;
          }
          return () => {
            stopIcon?.();
            stopPanel();
          };
        }),
      );
    }

    return { name: "dsh-workbuddy-pool-client", NS, PANEL_ID, ROUTES, apply, inject: ["slots", "locale"] };
  },
});
