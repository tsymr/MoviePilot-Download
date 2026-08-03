import { MESSAGE_TYPES } from "../shared/constants.js";
import { isMTeamDynamicDraft } from "../shared/mteam-adapter.js";
import {
  hasMoviePilotPermission,
  requestMoviePilotPermission,
  requestSendPermissions
} from "../shared/permissions.js";
import { getSettings } from "../shared/storage.js";
import { inferSiteName, isSupportedTorrentUrl } from "../shared/url-utils.js";

const elements = {
  configurationNotice: document.querySelector("#configurationNotice"),
  configureButton: document.querySelector("#configureButton"),
  refreshButton: document.querySelector("#refreshButton"),
  settingsButton: document.querySelector("#settingsButton"),
  enclosureInput: document.querySelector("#enclosureInput"),
  titleInput: document.querySelector("#titleInput"),
  descriptionInput: document.querySelector("#descriptionInput"),
  siteBadge: document.querySelector("#siteBadge"),
  recognizeButton: document.querySelector("#recognizeButton"),
  recognitionEmpty: document.querySelector("#recognitionEmpty"),
  recognitionResult: document.querySelector("#recognitionResult"),
  mediaTitle: document.querySelector("#mediaTitle"),
  mediaYear: document.querySelector("#mediaYear"),
  mediaType: document.querySelector("#mediaType"),
  mediaEpisode: document.querySelector("#mediaEpisode"),
  mediaCategory: document.querySelector("#mediaCategory"),
  downloaderSelect: document.querySelector("#downloaderSelect"),
  pathSelect: document.querySelector("#pathSelect"),
  sendButton: document.querySelector("#sendButton"),
  statusBar: document.querySelector("#statusBar"),
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText")
};

const state = {
  settings: null,
  pageDraft: null,
  configured: false,
  recognitionReady: false
};

/**
 * 让 Lucide 将占位元素替换为本地 SVG 图标。
 *
 * @returns {void}
 * @sideEffects 修改当前扩展页面中的图标节点；不会加载远程资源。
 */
function renderIcons() {
  globalThis.lucide?.createIcons({
    attrs: {
      "stroke-width": 1.8
    }
  });
}

/**
 * 更新底部状态栏。
 *
 * @param {"idle"|"working"|"success"|"error"} status 状态类型。
 * @param {string} message 展示文本。
 * @returns {void}
 * @sideEffects 更新 DOM 与 aria-live 内容。
 */
function setStatus(status, message) {
  elements.statusBar.dataset.state = status;
  elements.statusDot.dataset.state = status;
  elements.statusText.textContent = message;
}

/**
 * 切换操作按钮的忙碌状态，同时保持按钮尺寸稳定。
 *
 * @param {HTMLButtonElement} button 目标按钮。
 * @param {boolean} busy 是否正在执行。
 * @returns {void}
 * @sideEffects 修改按钮 disabled 和 aria-busy 属性。
 */
function setButtonBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

/**
 * 调用后台脚本并把统一失败响应转换为异常。
 *
 * @param {string} type MESSAGE_TYPES 中的消息类型。
 * @param {object} [payload] 附加消息数据。
 * @returns {Promise<object>} 后台成功响应。
 * @throws {Error} 后台返回失败或消息通道中断时抛出。
 * @sideEffects 由消息类型决定，可能读取页面或访问 MoviePilot。
 */
async function callBackground(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) {
    throw new Error(response?.error || "扩展后台没有返回有效结果");
  }
  return response;
}

/**
 * 从当前表单构造发送草稿，保留后台提取的页面和 User-Agent 上下文。
 *
 * @returns {object} 可发送给后台的种子草稿。
 * @sideEffects 只读取表单，不修改状态。
 */
function collectDraft() {
  return {
    ...(state.pageDraft ?? {}),
    enclosure: elements.enclosureInput.value.trim(),
    title: elements.titleInput.value.trim(),
    description: elements.descriptionInput.value.trim()
  };
}

/**
 * 将页面提取结果写入可编辑表单。
 *
 * @param {object} draft 页面种子草稿。
 * @returns {void}
 * @sideEffects 覆盖当前表单值并清除旧识别结果。
 */
function fillDraft(draft) {
  state.pageDraft = draft;
  elements.enclosureInput.value = draft?.enclosure ?? "";
  elements.titleInput.value = draft?.title ?? "";
  elements.descriptionInput.value = draft?.description ?? "";
  elements.enclosureInput.placeholder = isMTeamDynamicDraft(draft)
    ? "发送时自动生成 M-Team 临时下载地址"
    : "https://pt.example/download.php?id=...";
  elements.siteBadge.textContent = inferSiteName(draft?.pageUrl, draft?.enclosure);
  clearRecognition();
}

/**
 * 清除已经过期的媒体识别结果。
 *
 * @returns {void}
 * @sideEffects 切换识别结果 DOM 的可见性。
 */
function clearRecognition() {
  state.recognitionReady = false;
  elements.recognitionResult.hidden = true;
  elements.recognitionEmpty.hidden = false;
  if (state.settings?.recognizeBeforeDownload && state.configured) {
    // 开启确认模式后，标题或链接变化会使旧识别结果失效，必须重新识别才能发送。
    elements.sendButton.disabled = true;
  }
}

/**
 * 展示 MoviePilot 返回的媒体识别结果。
 *
 * @param {object} context MoviePilot Context 响应。
 * @returns {boolean} 识别到有效媒体时返回 true。
 * @sideEffects 更新媒体标题、类型、年份、季集与分类 DOM。
 */
function renderRecognition(context) {
  const media = context?.media_info;
  const meta = context?.meta_info;
  if (!media?.title) {
    clearRecognition();
    return false;
  }

  elements.mediaTitle.textContent = media.title ?? "—";
  elements.mediaYear.textContent = media.year ?? "—";
  elements.mediaType.textContent = media.type ?? "媒体";
  elements.mediaEpisode.textContent = meta?.season_episode
    || meta?.episode
    || "—";
  elements.mediaCategory.textContent = media.category ?? "默认";
  elements.recognitionEmpty.hidden = true;
  elements.recognitionResult.hidden = false;
  state.recognitionReady = true;
  elements.sendButton.disabled = !state.configured;
  return true;
}

/**
 * 用 MoviePilot 返回值填充选择框，并保留已保存但暂时离线的旧选项。
 *
 * @param {HTMLSelectElement} select 目标选择框。
 * @param {Array} items 接口返回的选项。
 * @param {string} selectedValue 期望选中的值。
 * @param {(item: any) => {value: string, label: string}} mapItem 选项映射函数。
 * @returns {void}
 * @sideEffects 重建选择框中除自动选项外的 option 节点。
 */
function populateSelect(select, items, selectedValue, mapItem) {
  while (select.options.length > 1) {
    select.remove(1);
  }
  for (const item of items) {
    const mapped = mapItem(item);
    if (!mapped.value) {
      continue;
    }
    select.add(new Option(mapped.label, mapped.value));
  }
  if (selectedValue && ![...select.options].some((option) => option.value === selectedValue)) {
    select.add(new Option(`${selectedValue}（已保存）`, selectedValue));
  }
  select.value = selectedValue ?? "";
}

/**
 * 从 MoviePilot 加载可用下载器和分类目录。
 *
 * @param {boolean} [silent] 静默模式下不覆盖当前状态栏。
 * @returns {Promise<void>} 选项加载完成后解决。
 * @throws {Error} MoviePilot 请求失败时抛出。
 * @sideEffects 发起只读请求并重建两个选择框。
 */
async function loadDownloadOptions(silent = false) {
  const result = await callBackground(MESSAGE_TYPES.GET_DOWNLOAD_OPTIONS);
  populateSelect(
    elements.downloaderSelect,
    result.downloaders,
    state.settings.defaultDownloader,
    (item) => ({
      value: item?.name ?? "",
      label: item?.type ? `${item.name} · ${item.type}` : item?.name ?? ""
    })
  );
  populateSelect(
    elements.pathSelect,
    result.paths,
    state.settings.defaultSavePath,
    (item) => {
      const rule = [item?.media_type, item?.media_category].filter(Boolean).join(" / ");
      return {
        value: item?.save_path ?? "",
        label: [item?.name || item?.download_path, rule].filter(Boolean).join(" · ")
      };
    }
  );
  if (!silent) {
    setStatus("success", "MoviePilot 下载路由已同步");
  }
}

/**
 * 从当前标签页重新提取种子信息。
 *
 * @returns {Promise<void>} 表单更新完成后解决。
 * @throws {Error} 当前页面不可读取时抛出。
 * @sideEffects 注入只读页面脚本并覆盖当前表单。
 */
async function refreshDraft() {
  setStatus("working", "正在读取当前页面");
  setButtonBusy(elements.refreshButton, true);
  try {
    const result = await callBackground(MESSAGE_TYPES.GET_DRAFT);
    fillDraft(result.draft);
    const hasDynamicDownload = isMTeamDynamicDraft(result.draft);
    const hasEnclosure = isSupportedTorrentUrl(result.draft?.enclosure);
    setStatus(
      hasEnclosure || hasDynamicDownload ? "success" : "idle",
      hasDynamicDownload
        ? "已识别 M-Team 资源，发送时将生成临时下载地址"
        : hasEnclosure
          ? "已提取种子链接，请核对标题"
          : "未检测到种子链接，可手动填写"
    );
  } finally {
    setButtonBusy(elements.refreshButton, false);
  }
}

/**
 * 请求 MoviePilot 识别当前标题。
 *
 * @param {object} [options] 识别调用选项。
 * @param {boolean} [options.requestPermission] 是否允许触发 Chrome 主机权限申请。
 * @returns {Promise<void>} 识别结果展示完成后解决。
 * @throws {Error} 权限被拒绝、标题为空或识别失败时抛出。
 * @sideEffects 手动模式可能弹出主机权限提示，并向 MoviePilot 发起识别请求。
 */
async function recognizeCurrentDraft({ requestPermission = true } = {}) {
  const draft = collectDraft();
  if (!draft.title) {
    elements.titleInput.focus();
    throw new Error("请先填写用于识别的发布标题");
  }
  clearRecognition();
  const granted = requestPermission
    ? await requestMoviePilotPermission(state.settings.baseUrl)
    : await hasMoviePilotPermission(state.settings.baseUrl);
  if (!granted) {
    throw new Error("未授予 MoviePilot 主机访问权限");
  }
  setStatus("working", "MoviePilot 正在识别媒体信息");
  setButtonBusy(elements.recognizeButton, true);
  try {
    const result = await callBackground(MESSAGE_TYPES.RECOGNIZE_TORRENT, {
      draft
    });
    if (!renderRecognition(result.context)) {
      throw new Error("MoviePilot 未能识别该标题，请调整发布标题后重试");
    }
    setStatus("success", "媒体识别完成，下载时将按该分类路由");
  } finally {
    setButtonBusy(elements.recognizeButton, false);
  }
}

/**
 * 校验并发送当前种子草稿。
 *
 * @returns {Promise<void>} MoviePilot 返回下载任务结果后解决。
 * @throws {Error} 表单、权限、Cookie 或下载请求失败时抛出。
 * @sideEffects 可能请求主机/Cookie 权限，并在 MoviePilot 下载器中创建任务。
 */
async function sendCurrentDraft() {
  const draft = collectDraft();
  if (!draft.title) {
    elements.titleInput.focus();
    throw new Error("请填写用于识别的发布标题");
  }
  if (!isSupportedTorrentUrl(draft.enclosure) && !isMTeamDynamicDraft(draft)) {
    elements.enclosureInput.focus();
    throw new Error("请填写有效的种子下载链接或磁力链接");
  }
  if (state.settings.recognizeBeforeDownload && !state.recognitionReady) {
    throw new Error("请先完成媒体识别，再确认发送");
  }

  const granted = await requestSendPermissions(
    state.settings.baseUrl,
    state.settings.includeCookiesByDefault
  );
  if (!granted) {
    throw new Error("所需访问权限未获授权");
  }

  setStatus("working", "正在发送，MoviePilot 将识别并创建下载任务");
  setButtonBusy(elements.sendButton, true);
  try {
    const result = await callBackground(MESSAGE_TYPES.SEND_TORRENT, {
      draft,
      downloader: elements.downloaderSelect.value,
      savePath: elements.pathSelect.value
    });
    const task = result.downloadId ? ` · ${result.downloadId.slice(0, 12)}` : "";
    const cookieState = state.settings.includeCookiesByDefault && !result.includedCookies
      ? " · 当前站点没有可用 Cookie"
      : "";
    setStatus("success", `下载任务已创建${task}${cookieState}`);
  } finally {
    setButtonBusy(elements.sendButton, false);
  }
}

/**
 * 初始化弹窗设置、页面草稿和下载选项。
 *
 * @returns {Promise<void>} 初始渲染完成后解决。
 * @throws {Error} 本地设置读取失败时抛出。
 * @sideEffects 读取 Chrome 存储、注入页面提取函数；确认模式下会自动访问 MoviePilot 识别。
 */
async function initialize() {
  renderIcons();
  state.settings = await getSettings();
  state.configured = Boolean(state.settings.apiToken);
  elements.configurationNotice.hidden = state.configured;
  elements.recognizeButton.disabled = !state.configured;
  elements.sendButton.disabled = !state.configured
    || state.settings.recognizeBeforeDownload;
  // 即使首次尚未授权联网，也要保留用户已配置的默认路由，防止发送时静默回退为自动值。
  populateSelect(
    elements.downloaderSelect,
    [],
    state.settings.defaultDownloader,
    () => ({ value: "", label: "" })
  );
  populateSelect(
    elements.pathSelect,
    [],
    state.settings.defaultSavePath,
    () => ({ value: "", label: "" })
  );

  try {
    await refreshDraft();
  } catch (error) {
    setStatus("error", error.message);
  }

  if (!state.configured) {
    return;
  }

  const hasPermission = await hasMoviePilotPermission(state.settings.baseUrl);
  if (hasPermission) {
    const optionLoad = loadDownloadOptions(true).catch(() => {
      // 选项加载失败不阻断手动发送，真正错误会在识别或发送时明确展示。
    });
    if (state.settings.recognizeBeforeDownload) {
      await Promise.all([
        optionLoad,
        recognizeCurrentDraft({ requestPermission: false })
      ]);
    } else {
      await optionLoad;
    }
  } else if (state.settings.recognizeBeforeDownload) {
    setStatus("error", "请先在扩展设置中测试连接并授予访问权限");
  }
}

elements.settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
elements.configureButton.addEventListener("click", () => chrome.runtime.openOptionsPage());

elements.refreshButton.addEventListener("click", () => {
  refreshDraft().catch((error) => setStatus("error", error.message));
});

elements.recognizeButton.addEventListener("click", () => {
  recognizeCurrentDraft().catch((error) => setStatus("error", error.message));
});

elements.sendButton.addEventListener("click", () => {
  sendCurrentDraft().catch((error) => setStatus("error", error.message));
});

for (const input of [elements.enclosureInput, elements.titleInput, elements.descriptionInput]) {
  input.addEventListener("input", () => {
    clearRecognition();
    if (input === elements.enclosureInput) {
      elements.siteBadge.textContent = inferSiteName(
        state.pageDraft?.pageUrl,
        elements.enclosureInput.value
      );
    }
  });
}

initialize().catch((error) => setStatus("error", error.message));
