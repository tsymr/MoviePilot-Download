/** 扩展持久化设置的存储键。 */
export const SETTINGS_KEY = "moviepilotSettings";

/** 仅在浏览器会话内保存的待发送草稿键。 */
export const PENDING_DRAFT_KEY = "pendingTorrentDraft";

/** MoviePilot REST API 的固定前缀。 */
export const API_PREFIX = "/api/v1";

/**
 * 设置默认值。API Token 只写入 chrome.storage.local，避免通过浏览器同步扩散到其他设备。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  baseUrl: "http://localhost:3000",
  apiToken: "",
  includeCookiesByDefault: true,
  recognizeBeforeDownload: false,
  defaultDownloader: "",
  defaultSavePath: ""
});

/** 后台脚本与扩展页面之间允许使用的消息类型。 */
export const MESSAGE_TYPES = Object.freeze({
  GET_DRAFT: "get-draft",
  GET_DOWNLOAD_OPTIONS: "get-download-options",
  RECOGNIZE_TORRENT: "recognize-torrent",
  SEND_TORRENT: "send-torrent",
  SYNC_CONTEXT_MENU: "sync-context-menu",
  TEST_CONNECTION: "test-connection"
});
