/**
 * 在当前网页底部展示 MoviePilot 发送状态。
 *
 * 此函数会被 chrome.scripting.executeScript 序列化后运行，必须保持完全自包含。
 * Shadow DOM 用于隔离 PT 站样式，消息通过 textContent 写入，避免把接口错误当作 HTML。
 *
 * @param {object} payload 提示内容。
 * @param {"working"|"success"|"error"} payload.state 提示状态。
 * @param {string} payload.message 可直接展示给用户的非敏感消息。
 * @returns {void}
 * @throws {Error} 页面 DOM 不可用或浏览器拒绝修改受保护页面时抛出。
 * @sideEffects 在当前页面顶层文档中插入一个固定定位提示；终态会在六秒后移除。
 */
export function renderMoviePilotToast(payload) {
  const state = new Set(["working", "success", "error"]).has(payload?.state)
    ? payload.state
    : "error";
  const message = String(payload?.message ?? "MoviePilot 请求处理失败");

  // 每次更新都替换旧容器，避免上一次提示的定时器误删新的发送结果。
  document.querySelectorAll("[data-moviepilot-pt-send-toast='true']")
    .forEach((element) => element.remove());

  const host = document.createElement("div");
  host.dataset.moviepilotPtSendToast = "true";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      position: fixed;
      left: 50%;
      bottom: max(20px, env(safe-area-inset-bottom));
      z-index: 2147483647;
      width: min(420px, calc(100vw - 32px));
      transform: translateX(-50%);
      color-scheme: light;
      pointer-events: none;
    }

    .toast {
      box-sizing: border-box;
      display: grid;
      grid-template-columns: 10px minmax(0, 1fr) 28px;
      align-items: center;
      gap: 12px;
      width: 100%;
      min-height: 54px;
      border: 1px solid #c9d0cb;
      border-radius: 6px;
      padding: 10px 10px 10px 14px;
      color: #1d2420;
      background: #ffffff;
      box-shadow: 0 12px 32px rgb(19 31 24 / 22%);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      opacity: 0;
      transform: translateY(12px);
      transition: opacity 160ms ease, transform 160ms ease;
      pointer-events: auto;
    }

    .toast.visible {
      opacity: 1;
      transform: translateY(0);
    }

    .indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #b77819;
      box-shadow: 0 0 0 3px rgb(183 120 25 / 14%);
    }

    .toast[data-state="success"] .indicator {
      background: #147a52;
      box-shadow: 0 0 0 3px rgb(20 122 82 / 14%);
    }

    .toast[data-state="error"] .indicator {
      background: #b83b32;
      box-shadow: 0 0 0 3px rgb(184 59 50 / 14%);
    }

    .content {
      min-width: 0;
    }

    .brand {
      margin: 0 0 2px;
      color: #536058;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
      font-weight: 700;
      line-height: 1.2;
    }

    .message {
      margin: 0;
      overflow-wrap: anywhere;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.4;
    }

    .close {
      position: relative;
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 4px;
      padding: 0;
      color: #66716a;
      background: transparent;
      cursor: pointer;
    }

    .close::before,
    .close::after {
      position: absolute;
      top: 13px;
      left: 8px;
      width: 12px;
      height: 1.5px;
      border-radius: 1px;
      background: currentColor;
      content: "";
    }

    .close::before { transform: rotate(45deg); }
    .close::after { transform: rotate(-45deg); }
    .close:hover { color: #1d2420; background: #eef1ee; }
    .close:focus-visible { outline: 2px solid #147a52; outline-offset: 1px; }

    @media (prefers-reduced-motion: reduce) {
      .toast { transition: none; }
    }
  `;

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.state = state;
  toast.setAttribute("role", state === "error" ? "alert" : "status");
  toast.setAttribute("aria-live", state === "error" ? "assertive" : "polite");

  const indicator = document.createElement("span");
  indicator.className = "indicator";
  indicator.setAttribute("aria-hidden", "true");

  const content = document.createElement("div");
  content.className = "content";
  const brand = document.createElement("p");
  brand.className = "brand";
  brand.textContent = "MOVIEPILOT PT SEND";
  const messageElement = document.createElement("p");
  messageElement.className = "message";
  messageElement.textContent = message;
  content.append(brand, messageElement);

  const closeButton = document.createElement("button");
  closeButton.className = "close";
  closeButton.type = "button";
  closeButton.title = "关闭提示";
  closeButton.setAttribute("aria-label", "关闭提示");
  closeButton.addEventListener("click", () => host.remove(), { once: true });

  toast.append(indicator, content, closeButton);
  shadow.append(style, toast);
  document.documentElement.append(host);
  requestAnimationFrame(() => toast.classList.add("visible"));

  const lifetime = state === "working" ? 120_000 : 6_000;
  setTimeout(() => host.remove(), lifetime);
}
