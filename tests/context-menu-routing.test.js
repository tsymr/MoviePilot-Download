import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backgroundSource = readFileSync(
  resolve(projectRoot, "src/background.js"),
  "utf8"
);

/**
 * 提取两个具名函数之间的源码，用于锁定菜单处理器的架构边界。
 *
 * @param {string} startName 起始函数名。
 * @param {string} endName 下一函数名，用作截取边界。
 * @returns {string} 起始函数的源码片段。
 * @throws {AssertionError} 任一函数不存在或顺序异常时抛出。
 * @sideEffects 无副作用，只读取模块初始化时载入的源码字符串。
 */
function getFunctionSection(startName, endName) {
  const start = backgroundSource.indexOf(`async function ${startName}`);
  const end = backgroundSource.indexOf(`async function ${endName}`, start + 1);
  assert.ok(start >= 0, `缺少函数：${startName}`);
  assert.ok(end > start, `无法确定函数边界：${startName}`);
  return backgroundSource.slice(start, end);
}

test("直发菜单处理器不允许打开扩展弹窗", () => {
  const directHandler = getFunctionSection(
    "handleDirectContextMenuClick",
    "handleRecognitionContextMenuClick"
  );
  assert.match(directHandler, /createDownload/);
  assert.doesNotMatch(directHandler, /openPopup/);
});

test("后台唯一弹窗调用只属于识别确认处理器", () => {
  const recognitionHandler = getFunctionSection(
    "handleRecognitionContextMenuClick",
    "protectLocalSettings"
  );
  assert.match(recognitionHandler, /chrome\.action\.openPopup/);
  assert.equal(
    backgroundSource.match(/chrome\.action\.openPopup/g)?.length,
    1
  );
});

test("M-Team 临时地址只在发送阶段通过页面主环境解析", () => {
  const resolver = getFunctionSection(
    "resolveDynamicDownloadDraft",
    "createDownload"
  );
  const downloadFlow = getFunctionSection("createDownload", "handleMessage");

  assert.match(resolver, /world:\s*"MAIN"/);
  assert.match(resolver, /resolveMTeamDownloadUrlFromPage/);
  assert.match(
    downloadFlow,
    /resolvedDraft\s*=\s*await resolveDynamicDownloadDraft\(draft\)/
  );
  assert.match(downloadFlow, /addTorrent\(settings, resolvedDraft/);
});
