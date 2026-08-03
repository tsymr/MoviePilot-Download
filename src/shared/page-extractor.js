/**
 * 从当前 PT 页面提取可编辑的种子草稿。
 *
 * 此函数会由 chrome.scripting.executeScript 序列化到页面隔离环境执行，因此实现必须保持
 * 完全自包含，不能引用模块级变量。它只读取 DOM、选区和 navigator，不修改页面内容。
 *
 * @param {string} [preferredUrl] 右键菜单明确选中的种子链接；为空时自动寻找最佳候选。
 * @returns {object} 包含标题、副标题、下载链接、详情页和 User-Agent 的草稿。
 * @throws {Error} document 或 location 不可用时由浏览器执行环境抛出。
 * @sideEffects 只读访问当前页面 DOM，不读取 Cookie，也不发起网络请求。
 */
export function extractTorrentPage(preferredUrl = "") {
  /** 清理页面文本，避免布局空白进入识别请求。 */
  const cleanText = (value) => String(value ?? "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  /** 将相对链接转换为可比较的绝对链接。 */
  const normalizeUrl = (value) => {
    const text = cleanText(value);
    if (!text) {
      return "";
    }
    if (/^magnet:\?/i.test(text)) {
      return text;
    }
    try {
      return new URL(text, location.href).href;
    } catch {
      return "";
    }
  };

  /**
   * 为链接计算种子下载可能性。PT 站实现差异很大，因此组合扩展名、路径、参数和文案，
   * 同时对详情、搜索、登录等常见误报路径降权。
   */
  const scoreLink = (anchor) => {
    const href = normalizeUrl(anchor?.getAttribute("href"));
    if (!href || /^(?:javascript|data|blob):/i.test(href)) {
      return Number.NEGATIVE_INFINITY;
    }
    if (/^magnet:\?/i.test(href)) {
      return 120;
    }

    const text = cleanText(anchor.textContent).toLowerCase();
    const url = href.toLowerCase();
    let score = 0;
    if (/\.torrent(?:$|[?#])/.test(url)) score += 100;
    if (/(?:^|\/)download(?:\.php|\/|$)/.test(url)) score += 75;
    if (/(?:^|\/)dl(?:\.php|\/|$)/.test(url)) score += 65;
    if (/[?&](?:action|type)=download(?:&|$)/.test(url)) score += 65;
    if (/[?&](?:torrent_?id|download_?id|id)=\d+/i.test(url)) score += 18;
    if (/(下载|種子|种子|torrent|download)/i.test(text)) score += 22;
    if (anchor.hasAttribute("download")) score += 25;
    if (/(details?|search|browse|login|signup|comment)/.test(url)) score -= 55;
    return score;
  };

  /** 从常见两列表格中按字段名提取值，兼容 NexusPHP 及其衍生主题。 */
  const findLabeledValue = (labelPattern) => {
    for (const row of document.querySelectorAll("tr")) {
      const cells = row.querySelectorAll(":scope > th, :scope > td");
      if (cells.length < 2) {
        continue;
      }
      const label = cleanText(cells[0].textContent).replace(/[：:]$/, "");
      if (labelPattern.test(label)) {
        return cleanText(cells[1].textContent);
      }
    }
    return "";
  };

  /** 判断候选文本是否只是按钮文案、站点导航或无意义占位。 */
  const isRejectedTitle = (value) => {
    const text = cleanText(value);
    if (text.length < 4 || text.length > 300) {
      return true;
    }
    return /^(?:下载|下載|下载本种|立即下载|种子|種子|torrent|download|详情|詳情|首页|首頁|返回)$/i
      .test(text);
  };

  /**
   * 为标题候选评分。发布名常见的年份、季集、分辨率和编码标记会提高可信度，
   * 但不把这些标记设为硬条件，以兼容中文主标题。
   */
  const scoreTitle = (value, sourceWeight) => {
    const text = cleanText(value);
    if (isRejectedTitle(text)) {
      return Number.NEGATIVE_INFINITY;
    }
    let score = sourceWeight + Math.min(text.length, 100) / 10;
    if (/(?:19|20)\d{2}|S\d{1,2}|E\d{1,3}|2160p|1080p|720p|BluRay|WEB[- .]?DL|REMUX|x26[45]|HEVC|AVC|HDR|DV/i.test(text)) {
      score += 24;
    }
    if (/[.\[\]_]/.test(text)) score += 8;
    if (/(?:电影|電視|电视剧|劇集|动画|動漫|纪录片|綜藝)/.test(text)) score += 8;
    if (/登录|註冊|规则|公告|控制面板|种子列表/i.test(text)) score -= 45;
    return score;
  };

  /** 去除明确等于当前站点名的页面标题后缀，不破坏发布名内部的连字符。 */
  const trimSiteSuffix = (value) => {
    let text = cleanText(value);
    const hostLabel = location.hostname.split(".").filter(Boolean)[0] ?? "";
    if (hostLabel) {
      const escaped = hostLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(`\\s*(?:[-|·])\\s*${escaped}\\s*$`, "i"), "");
    }
    return cleanText(text.replace(/^\s*(?:详情|詳情|种子详情|種子詳情)\s*[-|:]\s*/i, ""));
  };

  const anchors = [...document.querySelectorAll("a[href]")];
  const normalizedPreferred = normalizeUrl(preferredUrl);
  let selectedAnchor = null;
  let enclosure = normalizedPreferred;

  if (normalizedPreferred) {
    selectedAnchor = anchors.find(
      (anchor) => normalizeUrl(anchor.getAttribute("href")) === normalizedPreferred
    ) ?? null;
  } else {
    const rankedLinks = anchors
      .map((anchor) => ({ anchor, score: scoreLink(anchor) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);
    selectedAnchor = rankedLinks[0]?.anchor ?? null;
    enclosure = selectedAnchor
      ? normalizeUrl(selectedAnchor.getAttribute("href"))
      : "";
  }

  const scope = selectedAnchor?.closest(
    "tr, li, article, [class*='torrent'], [class*='result'], [class*='item']"
  ) ?? document;
  const titleCandidates = [];
  const addTitleCandidate = (value, weight) => {
    const text = trimSiteSuffix(value);
    const score = scoreTitle(text, weight);
    if (Number.isFinite(score)) {
      titleCandidates.push({ text, score });
    }
  };

  // 明确的字段和右键链接邻近内容优先，避免列表页误取页面总标题。
  addTitleCandidate(
    findLabeledValue(/^(?:种子名称|種子名稱|资源名称|資源名稱|标题|標題|片名)$/i),
    115
  );
  addTitleCandidate(selectedAnchor?.getAttribute("data-title"), 110);
  addTitleCandidate(selectedAnchor?.getAttribute("download"), 100);

  for (const element of scope.querySelectorAll(
    "[data-title], [title], .torrent-title, .torrentname, .release-name, h1, h2, h3, strong, b, a"
  )) {
    addTitleCandidate(
      element.getAttribute("data-title")
        || element.getAttribute("title")
        || element.textContent,
      75
    );
  }

  const selectedText = cleanText(globalThis.getSelection?.().toString());
  addTitleCandidate(selectedText, 72);
  addTitleCandidate(document.querySelector("meta[property='og:title']")?.content, 58);
  addTitleCandidate(document.querySelector("h1")?.textContent, 55);
  addTitleCandidate(document.querySelector("h2")?.textContent, 48);
  addTitleCandidate(document.title, 35);
  titleCandidates.sort((left, right) => right.score - left.score);

  const description = findLabeledValue(
    /^(?:副标题|副標題|副标|副標|简介|簡介|描述|资源描述|資源描述)$/i
  ) || cleanText(
    document.querySelector("[data-subtitle], .torrent-subtitle, .subtitle")?.textContent
      || document.querySelector("meta[name='description']")?.content
      || ""
  );

  return {
    title: titleCandidates[0]?.text ?? "",
    description: description.slice(0, 1000),
    enclosure,
    pageUrl: location.href,
    siteName: location.hostname,
    userAgent: navigator.userAgent,
    extractedAt: new Date().toISOString()
  };
}
