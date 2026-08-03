import { MESSAGE_TYPES } from "./shared/constants.js";
import {
  addTorrent,
  MoviePilotApiError,
  recognizeTorrent,
  testConnection
} from "./shared/moviepilot-api.js";
import { extractTorrentPage } from "./shared/page-extractor.js";
import {
  getSettings,
  setPendingDraft,
  takePendingDraft
} from "./shared/storage.js";

const CONTEXT_MENU_ID = "moviepilot-send-torrent";

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
 * @returns {Promise<object>} 页面提取结果。
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
  return draft;
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
 * 读取 URL 对应的浏览器 Cookie，并构造服务端可复用的 Cookie 请求头。
 *
 * 对同名 Cookie 按更长路径优先，尽量复现浏览器发送顺序；不同 URL 的结果会去重。
 * 该函数只应在用户明确启用“附带站点 Cookie”且已授予权限后调用。
 *
 * @param {string[]} urls 需要取得登录态的种子下载 URL。
 * @returns {Promise<string>} `name=value` 形式的 Cookie 请求头；没有 Cookie 时为空串。
 * @throws {Error} Chrome Cookie API 不可用或权限不足时 Promise 会拒绝。
 * @sideEffects 临时读取浏览器 Cookie；不会写入任何扩展存储。
 */
async function buildCookieHeader(urls) {
  const cookieMap = new Map();
  for (const value of urls) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      continue;
    }
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
      continue;
    }

    const cookies = await chrome.cookies.getAll({ url: parsed.href });
    cookies
      .sort((left, right) => right.path.length - left.path.length)
      .forEach((cookie) => {
        const key = `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
        cookieMap.set(key, cookie);
      });
  }
  return [...cookieMap.values()]
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
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
  await chrome.action.setBadgeBackgroundColor({ color: selected.color });
  await chrome.action.setBadgeText({ text: selected.text });
  if (state !== "working") {
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 5_000);
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
      await setActionState("working");
      try {
        const cookieHeader = message.includeCookies
          ? await buildCookieHeader([
              message.draft?.enclosure
            ])
          : "";
        const result = await addTorrent(settings, message.draft, {
          downloader: message.downloader,
          savePath: message.savePath,
          cookieHeader
        });
        await setActionState("success");
        return { ok: true, ...result, includedCookies: Boolean(cookieHeader) };
      } catch (error) {
        await setActionState("error");
        throw error;
      }
    }
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
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "识别并发送到 MoviePilot",
    contexts: ["link", "page"],
    documentUrlPatterns: ["http://*/*", "https://*/*"]
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
  installContextMenu().catch(() => {
    // 安装阶段无法向用户展示弹窗，保留工具栏入口作为降级路径。
  });
});

chrome.runtime.onStartup.addListener(() => {
  installContextMenu().catch(() => {
    // 菜单创建失败不影响用户通过工具栏弹窗发送种子。
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) {
    return;
  }

  extractDraftFromTab(tab.id, info.linkUrl ?? "", info.frameId ?? 0)
    .then(setPendingDraft)
    .then(() => chrome.action.openPopup())
    .catch(async () => {
      await setActionState("error");
      await chrome.notifications.create({
        type: "basic",
        iconUrl: "assets/icon128.png",
        title: "MoviePilot PT Send",
        message: "无法读取该页面，请打开扩展弹窗后手动填写链接。"
      });
    });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse(serializeError(error)));
  // 保持消息通道，直到异步 MoviePilot 请求或页面提取完成。
  return true;
});
