import { MESSAGE_TYPES } from "../shared/constants.js";
import { requestMoviePilotPermission } from "../shared/permissions.js";
import { getSettings, saveSettings } from "../shared/storage.js";
import { normalizeBaseUrl } from "../shared/url-utils.js";

const elements = {
  form: document.querySelector("#settingsForm"),
  baseUrlInput: document.querySelector("#baseUrlInput"),
  apiTokenInput: document.querySelector("#apiTokenInput"),
  tokenVisibilityButton: document.querySelector("#tokenVisibilityButton"),
  defaultDownloaderSelect: document.querySelector("#defaultDownloaderSelect"),
  defaultPathSelect: document.querySelector("#defaultPathSelect"),
  includeCookiesInput: document.querySelector("#includeCookiesInput"),
  testButton: document.querySelector("#testButton"),
  saveButton: document.querySelector("#saveButton"),
  formStatus: document.querySelector("#formStatus"),
  statusDot: document.querySelector("#statusDot"),
  headerState: document.querySelector("#headerState")
};

/**
 * 让 Lucide 将本地图标占位元素转换为 SVG。
 *
 * @returns {void}
 * @sideEffects 修改设置页中的图标节点，不访问网络。
 */
function renderIcons() {
  globalThis.lucide?.createIcons({ attrs: { "stroke-width": 1.8 } });
}

/**
 * 同步更新页头连接状态和底部表单状态。
 *
 * @param {"idle"|"working"|"success"|"error"} status 状态类型。
 * @param {string} message 展示文本。
 * @returns {void}
 * @sideEffects 更新 DOM 和 aria-live 内容。
 */
function setStatus(status, message) {
  elements.formStatus.dataset.state = status;
  elements.formStatus.textContent = message;
  elements.statusDot.dataset.state = status;
  elements.headerState.textContent = {
    success: "连接正常",
    error: "连接失败",
    working: "正在检测",
    idle: "尚未检测"
  }[status];
}

/**
 * 切换按钮忙碌状态，防止重复保存或并发测试。
 *
 * @param {HTMLButtonElement} button 目标按钮。
 * @param {boolean} busy 是否正在执行。
 * @returns {void}
 * @sideEffects 修改 disabled 和 aria-busy 属性。
 */
function setButtonBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

/**
 * 从设置表单收集原始值。
 *
 * @returns {object} 可交给 saveSettings 校验的设置对象。
 * @sideEffects 只读访问 DOM。
 */
function collectSettings() {
  return {
    baseUrl: elements.baseUrlInput.value,
    apiToken: elements.apiTokenInput.value,
    includeCookiesByDefault: elements.includeCookiesInput.checked,
    defaultDownloader: elements.defaultDownloaderSelect.value,
    defaultSavePath: elements.defaultPathSelect.value
  };
}

/**
 * 将保存的设置写回表单。
 *
 * @param {object} settings 扩展设置。
 * @returns {void}
 * @sideEffects 覆盖表单值。
 */
function fillSettings(settings) {
  elements.baseUrlInput.value = settings.baseUrl;
  elements.apiTokenInput.value = settings.apiToken;
  elements.includeCookiesInput.checked = settings.includeCookiesByDefault;
  ensureStoredOption(
    elements.defaultDownloaderSelect,
    settings.defaultDownloader,
    "已保存下载器"
  );
  ensureStoredOption(
    elements.defaultPathSelect,
    settings.defaultSavePath,
    "已保存路径"
  );
}

/**
 * 为接口暂不可用时的已保存值补充选项，避免打开设置页就意外清空默认路由。
 *
 * @param {HTMLSelectElement} select 目标选择框。
 * @param {string} value 已保存值。
 * @param {string} suffix 离线选项说明。
 * @returns {void}
 * @sideEffects 可能向选择框添加一个 option 并选中。
 */
function ensureStoredOption(select, value, suffix) {
  if (!value) {
    select.value = "";
    return;
  }
  if (![...select.options].some((option) => option.value === value)) {
    select.add(new Option(`${value}（${suffix}）`, value));
  }
  select.value = value;
}

/**
 * 用 MoviePilot 返回值刷新默认路由选项。
 *
 * @param {Array} downloaders 可用下载器。
 * @param {Array} paths 可用下载目录。
 * @param {object} selected 当前保存设置。
 * @returns {void}
 * @sideEffects 重建下载器和路径选择框。
 */
function fillDownloadOptions(downloaders, paths, selected) {
  elements.defaultDownloaderSelect.replaceChildren(
    new Option("MoviePilot 自动选择", "")
  );
  for (const item of downloaders) {
    if (item?.name) {
      elements.defaultDownloaderSelect.add(
        new Option(item.type ? `${item.name} · ${item.type}` : item.name, item.name)
      );
    }
  }
  ensureStoredOption(
    elements.defaultDownloaderSelect,
    selected.defaultDownloader,
    "已保存下载器"
  );

  elements.defaultPathSelect.replaceChildren(
    new Option("按媒体分类自动选择", "")
  );
  for (const item of paths) {
    if (!item?.save_path) {
      continue;
    }
    const rule = [item.media_type, item.media_category].filter(Boolean).join(" / ");
    const label = [item.name || item.download_path, rule].filter(Boolean).join(" · ");
    elements.defaultPathSelect.add(new Option(label, item.save_path));
  }
  ensureStoredOption(
    elements.defaultPathSelect,
    selected.defaultSavePath,
    "已保存路径"
  );
}

/**
 * 发送后台消息并把失败响应转换为异常。
 *
 * @param {string} type MESSAGE_TYPES 中的消息类型。
 * @returns {Promise<object>} 后台成功响应。
 * @throws {Error} 后台请求失败时抛出。
 * @sideEffects 由消息类型决定；本页只用于 MoviePilot 只读连接测试。
 */
async function callBackground(type) {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) {
    throw new Error(response?.error || "MoviePilot 没有返回有效响应");
  }
  return response;
}

/**
 * 保存当前设置。
 *
 * @returns {Promise<object>} 已规范化的设置。
 * @throws {TypeError|Error} 表单校验或 Chrome 存储失败时抛出。
 * @sideEffects 写入 chrome.storage.local。
 */
async function saveCurrentSettings() {
  setButtonBusy(elements.saveButton, true);
  setStatus("working", "正在保存设置");
  try {
    const saved = await saveSettings(collectSettings());
    elements.baseUrlInput.value = saved.baseUrl;
    setStatus("idle", "设置已保存，尚未测试连接");
    return saved;
  } finally {
    setButtonBusy(elements.saveButton, false);
  }
}

/**
 * 保存表单、申请 MoviePilot 主机权限并测试 API。
 *
 * @returns {Promise<void>} 下载选项同步完成后解决。
 * @throws {Error} 校验、权限、网络或鉴权失败时抛出。
 * @sideEffects 写入设置、可能弹出权限确认，并向 MoviePilot 发起两次只读请求。
 */
async function testCurrentConnection() {
  setButtonBusy(elements.testButton, true);
  setStatus("working", "正在连接 MoviePilot");
  try {
    const input = collectSettings();
    const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl);
    const apiToken = String(input.apiToken ?? "").trim();
    if (apiToken.length < 16) {
      throw new TypeError("MoviePilot API Token 至少需要 16 个字符");
    }

    // 权限请求必须直接发生在点击手势中，不能放到异步存储写入之后。
    const granted = await requestMoviePilotPermission(normalizedBaseUrl);
    if (!granted) {
      throw new Error("未授予 MoviePilot 主机访问权限");
    }
    const saved = await saveSettings(input);
    elements.baseUrlInput.value = saved.baseUrl;
    const result = await callBackground(MESSAGE_TYPES.TEST_CONNECTION);
    fillDownloadOptions(result.downloaders, result.paths, saved);
    setStatus(
      "success",
      `连接成功 · ${result.downloaders.length} 个下载器 · ${result.paths.length} 个路径`
    );
  } finally {
    setButtonBusy(elements.testButton, false);
  }
}

/**
 * 初始化设置页。
 *
 * @returns {Promise<void>} 设置读取和首屏渲染完成后解决。
 * @throws {Error} Chrome 存储不可用时抛出。
 * @sideEffects 读取本地设置并更新表单，不主动请求主机权限或网络。
 */
async function initialize() {
  renderIcons();
  fillSettings(await getSettings());
  setStatus("idle", "设置已载入");
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  saveCurrentSettings().catch((error) => setStatus("error", error.message));
});

elements.testButton.addEventListener("click", () => {
  testCurrentConnection().catch((error) => setStatus("error", error.message));
});

elements.tokenVisibilityButton.addEventListener("click", () => {
  const showing = elements.apiTokenInput.type === "text";
  elements.apiTokenInput.type = showing ? "password" : "text";
  elements.tokenVisibilityButton.title = showing ? "显示 API Token" : "隐藏 API Token";
  elements.tokenVisibilityButton.setAttribute(
    "aria-label",
    elements.tokenVisibilityButton.title
  );
  elements.tokenVisibilityButton.innerHTML = showing
    ? '<i data-lucide="eye" aria-hidden="true"></i>'
    : '<i data-lucide="eye-off" aria-hidden="true"></i>';
  renderIcons();
});

initialize().catch((error) => setStatus("error", error.message));
