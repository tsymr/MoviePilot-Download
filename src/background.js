import { MESSAGE_TYPES, SETTINGS_KEY } from "./shared/constants.js";
import {
  addTorrent,
  MoviePilotApiError,
  recognizeTorrent,
  testConnection
} from "./shared/moviepilot-api.js";
import { extractTorrentPage } from "./shared/page-extractor.js";
import { renderMoviePilotToast } from "./shared/page-toast.js";
import {
  isMTeamDynamicDraft,
  resolveMTeamDownloadUrlFromPage
} from "./shared/mteam-adapter.js";
import { hasMoviePilotPermission } from "./shared/permissions.js";
import {
  CONTEXT_MENU_IDS,
  getContextMenuDefinition
} from "./shared/settings-policy.js";
import {
  getSettings,
  setPendingDraft,
  takePendingDraft
} from "./shared/storage.js";
import { isSupportedTorrentUrl } from "./shared/url-utils.js";

let contextMenuInstallQueue = Promise.resolve();

/**
 * 将未知异常转换为可跨扩展消息边界传递的非敏感结构。
 *
 * @param {unknown} error 捕获到的异常。
 * @returns {{ok: false, error: string, code: string, status: number}} 序列化错误。
 * @sideEffects 无副作用，不记录 API Token、Cookie 或种子链接。
 */
function serializeError(error) {
  return {
    ok: false,
    error: error instanceof Error ? error.message : "扩展处理请求失败",
    code: error instanceof MoviePilotApiError ? error.code : "EXTENSION_ERROR",
    status: error instanceof MoviePilotApiError ? error.status : 0
  };
}

/**
 * 在指定标签页的隔离环境中提取种子草稿。
 *
 * @param {number} tabId Chrome 标签页 ID。
 * @param {string} [preferredUrl] 右键菜单选中的链接。
 * @param {number} [frameId] 右键发生的页面 frame；默认读取顶层页面。
 * @returns {Promise<object>} 页面提取结果，附带后续网页提示所需的标签页上下文。
 * @throws {Error} 页面受 Chrome 保护、标签页不存在或脚本无结果时抛出。
 * @sideEffects 向标签页注入一次只读提取函数，不修改页面。
 */
async function extractDraftFromTab(tabId, preferredUrl = "", frameId = 0) {
  const results = await chrome.scripting.executeScript({
    target: {
      tabId,
      frameIds: [frameId]
    },
    func: extractTorrentPage,
    args: [preferredUrl]
  });
  const draft = results?.[0]?.result;
  if (!draft) {
    throw new Error("无法读取当前页面，请在 PT 详情页或种子链接上重试");
  }
  return {
    ...draft,
    sourceTabId: tabId,
    sourceFrameId: frameId
  };
}

/**
 * 读取当前活动标签页并生成草稿。
 *
 * @returns {Promise<object>} 页面种子草稿。
 * @throws {Error} 当前没有可访问标签页时抛出。
 * @sideEffects 注入一次只读页面提取函数。
 */
async function extractDraftFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("当前没有可读取的页面");
  }
  return extractDraftFromTab(tab.id);
}

/**
 * 读取当前 PT 页面对应的浏览器 Cookie，并构造服务端可复用的 Cookie 请求头。
 *
 * 对同名 Cookie 按更长路径优先，尽量复现浏览器发送顺序。Cookie 来源固定为
 * pageUrl 而不是种子下载地址，因为后者可能跳转到 CDN 或一次性下载域名。
 *
 * @param {string} pageUrl 当前 PT 详情页 URL。
 * @returns {Promise<string>} `name=value` 形式的 Cookie 请求头；没有 Cookie 时为空串。
 * @throws {Error} 页面地址无效、Cookie 配置未完成或 Chrome Cookie API 不可用时抛出。
 * @sideEffects 临时读取浏览器 Cookie；不会写入任何扩展存储。
 */
async function buildCookieHeader(pageUrl) {
  let parsed;
  try {
    parsed = new URL(pageUrl);
  } catch {
    throw new Error("当前 PT 页面地址无效，无法读取 Cookie");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("当前页面不支持读取 PT Cookie");
  }
  if (!await chrome.permissions.contains({ permissions: ["cookies"] })) {
    throw new Error("Cookie 权限尚未启用，请在扩展设置中重新保存配置");
  }

  let cookies;
  try {
    cookies = await chrome.cookies.getAll({ url: parsed.href });
  } catch {
    // Chrome 原始错误可能包含完整页面 URL，这里改为稳定且不泄露链接的提示。
    throw new Error("无法读取当前 PT 站 Cookie，请在扩展设置中重新保存配置");
  }
  return cookies
    .sort((left, right) => right.path.length - left.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

/**
 * 将发送状态显示在来源网页底部，受保护页面不可注入时退回浏览器通知。
 *
 * 工作状态不创建浏览器通知，避免右键发送时产生两次系统级打扰；成功和失败只有在
 * 页面提示无法显示时才使用通知兜底。
 *
 * @param {object} draft 种子草稿，需包含 sourceTabId。
 * @param {"working"|"success"|"error"} state 当前发送状态。
 * @param {string} message 可直接展示的非敏感消息。
 * @returns {Promise<boolean>} 网页提示显示成功时返回 true，使用降级路径时返回 false。
 * @sideEffects 向来源网页注入提示，或在终态创建一条 Chrome 通知。
 */
async function showPageStatus(draft, state, message) {
  const tabId = Number(draft?.sourceTabId);
  if (Number.isInteger(tabId) && tabId >= 0) {
    try {
      // 提示固定注入顶层文档，即使右键来自 iframe，也能在完整页面底部稳定可见。
      await chrome.scripting.executeScript({
        target: { tabId },
        func: renderMoviePilotToast,
        args: [{ state, message }]
      });
      return true;
    } catch {
      // 页面可能已跳转或属于 Chrome 保护页，终态继续走浏览器通知降级。
    }
  }

  if (state !== "working") {
    try {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: "assets/icon128.png",
        title: state === "success" ? "MoviePilot 下载任务已创建" : "MoviePilot 发送失败",
        message
      });
    } catch {
      // 结果仍会通过角标或弹窗状态返回，通知失败不能覆盖原始发送结果。
    }
  }
  return false;
}

/**
 * 设置短暂的扩展角标，便于用户在弹窗关闭后仍能看到发送结果。
 *
 * @param {"working"|"success"|"error"} state 当前发送状态。
 * @returns {Promise<void>} 角标设置完成后解决。
 * @sideEffects 修改扩展工具栏角标，并在终态五秒后自动清除。
 */
async function setActionState(state) {
  const states = {
    working: { text: "…", color: "#176b4d" },
    success: { text: "OK", color: "#16784f" },
    error: { text: "!", color: "#b83b32" }
  };
  const selected = states[state];
  try {
    await chrome.action.setBadgeBackgroundColor({ color: selected.color });
    await chrome.action.setBadgeText({ text: selected.text });
    if (state !== "working") {
      setTimeout(() => {
        chrome.action.setBadgeText({ text: "" }).catch(() => undefined);
      }, 5_000);
    }
  } catch {
    // 角标只是辅助反馈，浏览器工具栏不可用时不能改变真实下载结果。
  }
}

/**
 * 将需要站点登录态的动态草稿转换为 MoviePilot 可直接下载的临时 URL。
 *
 * 普通 HTTP(S) 和 magnet 草稿原样返回。M-Team 草稿只在真正发送前解析，避免确认弹窗
 * 停留时间过长导致短期令牌失效；解析结果只存在于本次调用内存中。
 *
 * @param {object} draft 页面提取或用户编辑后的种子草稿。
 * @returns {Promise<object>} 带有可下载 enclosure 的草稿。
 * @throws {Error} 来源标签页失效、页面已跳转或 M-Team 无法生成地址时抛出。
 * @sideEffects 对 M-Team 草稿会在来源页 MAIN world 中读取必要登录态并请求一次临时令牌。
 */
async function resolveDynamicDownloadDraft(draft) {
  if (isSupportedTorrentUrl(draft?.enclosure) || !isMTeamDynamicDraft(draft)) {
    return draft;
  }

  const tabId = Number(draft?.sourceTabId);
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error("M-Team 来源页面已失效，请回到资源详情页重试");
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      func: resolveMTeamDownloadUrlFromPage,
      args: [draft.torrentId]
    });
  } catch {
    // 不透传 Chrome 的主环境异常，避免错误栈意外包含页面内部状态或临时令牌。
    throw new Error("无法生成 M-Team 临时下载地址，请确认资源页仍处于登录状态");
  }

  const enclosure = String(results?.[0]?.result ?? "").trim();
  if (!isSupportedTorrentUrl(enclosure)) {
    throw new Error("M-Team 没有返回有效的临时下载地址");
  }
  return { ...draft, enclosure };
}

/**
 * 按已保存配置向 MoviePilot 创建下载任务，并统一更新网页提示与扩展角标。
 *
 * Cookie 策略只读取 settings.includeCookiesByDefault，调用方不能按单次发送覆盖，
 * 从而保证右键直发、弹窗确认和设置页展示始终使用同一策略。
 *
 * @param {object} settings 已保存的扩展设置。
 * @param {object} draft 当前种子草稿及来源标签页上下文。
 * @param {object} [delivery] 下载路由覆盖项。
 * @param {string} [delivery.downloader] 下载器名称；为空时由 MoviePilot 自动选择。
 * @param {string} [delivery.savePath] 保存路径；为空时由 MoviePilot 自动分类。
 * @returns {Promise<object>} MoviePilot 下载结果及本次是否实际附带 Cookie。
 * @throws {Error} Cookie 读取、参数校验或 MoviePilot 下载请求失败时抛出。
 * @sideEffects 读取临时 Cookie、访问 MoviePilot、创建下载任务并更新网页提示与角标。
 */
async function createDownload(settings, draft, delivery = {}) {
  await setActionState("working");
  await showPageStatus(draft, "working", "正在发送到 MoviePilot");

  try {
    const resolvedDraft = await resolveDynamicDownloadDraft(draft);
    const cookieHeader = settings.includeCookiesByDefault
      ? await buildCookieHeader(draft?.pageUrl)
      : "";
    const result = await addTorrent(settings, resolvedDraft, {
      downloader: delivery.downloader,
      savePath: delivery.savePath,
      cookieHeader
    });
    const cookieNote = settings.includeCookiesByDefault && !cookieHeader
      ? "；当前站点没有可用 Cookie"
      : "";
    await setActionState("success");
    await showPageStatus(
      draft,
      "success",
      `MoviePilot 已创建下载任务${cookieNote}`
    );
    return { ...result, includedCookies: Boolean(cookieHeader) };
  } catch (error) {
    await setActionState("error");
    await showPageStatus(
      draft,
      "error",
      error instanceof Error ? error.message : "发送到 MoviePilot 失败"
    );
    throw error;
  }
}

/**
 * 处理弹窗和设置页发送的后台消息。
 *
 * @param {object} message 消息对象，type 必须属于 MESSAGE_TYPES。
 * @returns {Promise<object>} 可序列化的成功结果。
 * @throws {Error} 消息无效或底层操作失败时抛出。
 * @sideEffects 根据消息类型读取页面、访问 MoviePilot、读取临时 Cookie 或创建下载任务。
 */
async function handleMessage(message) {
  switch (message?.type) {
    case MESSAGE_TYPES.GET_DRAFT: {
      const pending = await takePendingDraft();
      return { ok: true, draft: pending ?? await extractDraftFromActiveTab() };
    }
    case MESSAGE_TYPES.TEST_CONNECTION:
    case MESSAGE_TYPES.GET_DOWNLOAD_OPTIONS: {
      const settings = await getSettings();
      const options = await testConnection(settings);
      return { ok: true, ...options };
    }
    case MESSAGE_TYPES.RECOGNIZE_TORRENT: {
      const settings = await getSettings();
      const context = await recognizeTorrent(settings, message.draft);
      return { ok: true, context };
    }
    case MESSAGE_TYPES.SEND_TORRENT: {
      const settings = await getSettings();
      const result = await createDownload(settings, message.draft, {
        downloader: message.downloader,
        savePath: message.savePath
      });
      return { ok: true, ...result };
    }
    case MESSAGE_TYPES.SYNC_CONTEXT_MENU:
      await queueContextMenuInstall();
      return { ok: true };
    default:
      throw new Error("不支持的扩展消息");
  }
}

/**
 * 创建或刷新右键菜单。
 *
 * @returns {Promise<void>} 菜单创建完成后解决。
 * @sideEffects 覆盖本扩展的全部右键菜单项。
 */
async function installContextMenu() {
  const settings = await getSettings();
  const menu = getContextMenuDefinition(settings);
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: menu.id,
    title: menu.title,
    contexts: ["link", "page"],
    documentUrlPatterns: ["http://*/*", "https://*/*"]
  });
}

/**
 * 串行重建右键菜单，避免设置保存与扩展生命周期事件并发时互相删除新菜单。
 *
 * @returns {Promise<void>} 当前排队的菜单重建完成后解决。
 * @throws {Error} 设置读取或 Chrome 右键菜单 API 失败时 Promise 会拒绝。
 * @sideEffects 更新模块内队列，并覆盖本扩展的全部右键菜单项。
 */
function queueContextMenuInstall() {
  contextMenuInstallQueue = contextMenuInstallQueue
    .catch(() => undefined)
    .then(installContextMenu);
  return contextMenuInstallQueue;
}

/**
 * 在右键来源页面提取草稿和已保存设置，并统一处理准备阶段错误。
 *
 * @param {chrome.contextMenus.OnClickData} info 右键菜单点击上下文。
 * @param {chrome.tabs.Tab} tab 触发菜单的标签页。
 * @param {(context: {draft: object, settings: object}) => Promise<void>} action 模式专属操作。
 * @returns {Promise<void>} 模式操作或错误反馈完成后解决。
 * @sideEffects 读取页面和设置，并根据 action 访问 MoviePilot 或打开确认弹窗。
 */
async function runContextMenuAction(info, tab, action) {
  let draft = { sourceTabId: tab.id };
  try {
    draft = await extractDraftFromTab(
      tab.id,
      info.linkUrl ?? "",
      info.frameId ?? 0
    );
    const settings = await getSettings();
    if (!settings.apiToken) {
      throw new Error("请先在扩展设置中配置 MoviePilot");
    }
    await action({ draft, settings });
  } catch (error) {
    await setActionState("error");
    await showPageStatus(
      draft,
      "error",
      error instanceof Error ? error.message : "无法处理当前 PT 页面"
    );
  }
}

/**
 * 处理“直接发送”菜单，不经过任何弹窗或媒体识别预览。
 *
 * 该处理器只会使用已保存的下载器、路径和 Cookie 策略创建任务。所需权限必须预先
 * 在设置页授予，缺少权限时直接在来源网页底部显示失败，不触发权限或确认弹窗。
 *
 * @param {chrome.contextMenus.OnClickData} info 右键菜单点击上下文。
 * @param {chrome.tabs.Tab} tab 触发菜单的标签页。
 * @returns {Promise<void>} 下载完成或错误反馈显示后解决。
 * @sideEffects 读取页面与设置，并可能向 MoviePilot 创建下载任务。
 */
async function handleDirectContextMenuClick(info, tab) {
  await runContextMenuAction(info, tab, async ({ draft, settings }) => {
    if (!await hasMoviePilotPermission(settings.baseUrl)) {
      throw new Error("请先在扩展设置中保存配置并授予 MoviePilot 访问权限");
    }

    // createDownload 已完整展示终态，菜单监听器不需要再次报告相同错误。
    await createDownload(settings, draft, {
      downloader: settings.defaultDownloader,
      savePath: settings.defaultSavePath
    }).catch(() => undefined);
  });
}

/**
 * 处理“识别并发送”菜单，暂存草稿后打开媒体识别确认弹窗。
 *
 * @param {chrome.contextMenus.OnClickData} info 右键菜单点击上下文。
 * @param {chrome.tabs.Tab} tab 触发菜单的标签页。
 * @returns {Promise<void>} 草稿暂存并打开弹窗后解决。
 * @sideEffects 读取页面与设置、写入会话草稿并打开扩展弹窗。
 */
async function handleRecognitionContextMenuClick(info, tab) {
  await runContextMenuAction(info, tab, async ({ draft }) => {
    await setPendingDraft(draft);
    await chrome.action.openPopup();
  });
}

/**
 * 限制本地设置只对扩展可信上下文可见。
 *
 * 这样即使未来增加常驻内容脚本，页面侧隔离环境也无法读取保存的 API Token。
 *
 * @returns {Promise<void>} 访问级别设置完成后解决。
 * @throws {Error} Chrome Storage API 不可用时 Promise 会拒绝。
 * @sideEffects 修改 chrome.storage.local 的访问级别，不修改已保存的数据。
 */
async function protectLocalSettings() {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS"
  });
}

protectLocalSettings().catch(() => {
  // Chrome 127+ 支持该接口；失败时仍不影响主流程，且当前扩展没有常驻内容脚本。
});

chrome.runtime.onInstalled.addListener(() => {
  queueContextMenuInstall().catch(() => {
    // 安装阶段无法向用户展示弹窗，保留工具栏入口作为降级路径。
  });
});

chrome.runtime.onStartup.addListener(() => {
  queueContextMenuInstall().catch(() => {
    // 菜单创建失败不影响用户通过工具栏弹窗发送种子。
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[SETTINGS_KEY]) {
    return;
  }
  queueContextMenuInstall().catch(() => {
    // 菜单重建失败不修改设置，下次启动仍会按当前策略重新创建。
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) {
    return;
  }
  const handler = {
    [CONTEXT_MENU_IDS.DIRECT_SEND]: handleDirectContextMenuClick,
    [CONTEXT_MENU_IDS.RECOGNIZE_SEND]: handleRecognitionContextMenuClick
  }[info.menuItemId];
  if (!handler) {
    return;
  }
  handler(info, tab).catch(() => {
    // 模式处理器已尽力展示错误；监听器不得留下未处理的 Promise。
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse(serializeError(error)));
  // 保持消息通道，直到异步 MoviePilot 请求或页面提取完成。
  return true;
});
