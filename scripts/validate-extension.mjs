import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(projectRoot, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

/**
 * 断言项目相对路径存在。
 *
 * @param {string} relativePath 相对项目根目录的路径。
 * @returns {string} 已确认存在的绝对路径。
 * @throws {AssertionError} 文件不存在时抛出。
 * @sideEffects 只读检查文件系统。
 */
function requireFile(relativePath) {
  const absolutePath = resolve(projectRoot, relativePath);
  assert.ok(existsSync(absolutePath), `缺少扩展文件：${relativePath}`);
  return absolutePath;
}

/**
 * 递归收集目录中的指定扩展名文件。
 *
 * @param {string} directory 起始目录。
 * @param {Set<string>} extensions 允许的文件扩展名。
 * @returns {string[]} 绝对文件路径列表。
 * @sideEffects 只读遍历文件系统。
 */
function collectFiles(directory, extensions) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolutePath = resolve(directory, entry);
    if (statSync(absolutePath).isDirectory()) {
      files.push(...collectFiles(absolutePath, extensions));
    } else if (extensions.has(extname(entry))) {
      files.push(absolutePath);
    }
  }
  return files;
}

/**
 * 检查 HTML 中引用的本地脚本、样式和图片存在。
 *
 * @param {string} htmlPath HTML 文件绝对路径。
 * @returns {void}
 * @throws {AssertionError} 本地引用缺失时抛出。
 * @sideEffects 只读访问 HTML 与引用文件。
 */
function validateHtmlReferences(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const referencePattern = /(?:src|href)="([^"]+)"/g;
  for (const match of html.matchAll(referencePattern)) {
    const reference = match[1];
    if (/^(?:https?:|#|data:)/.test(reference)) {
      continue;
    }
    assert.ok(
      existsSync(resolve(dirname(htmlPath), reference)),
      `${htmlPath} 引用了不存在的本地资源：${reference}`
    );
  }
}

/**
 * 检查 ES Module 的相对导入目标存在。
 *
 * @param {string} scriptPath JavaScript 文件绝对路径。
 * @returns {void}
 * @throws {AssertionError} 相对模块缺失时抛出。
 * @sideEffects 只读访问 JavaScript 文件系统。
 */
function validateModuleImports(scriptPath) {
  const source = readFileSync(scriptPath, "utf8");
  const importPattern = /\bfrom\s+["'](\.[^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    assert.ok(
      existsSync(resolve(dirname(scriptPath), match[1])),
      `${scriptPath} 导入了不存在的模块：${match[1]}`
    );
  }
}

assert.equal(manifest.manifest_version, 3, "扩展必须使用 Manifest V3");
assert.equal(manifest.background?.type, "module", "后台脚本必须使用 ES Module");
assert.ok(
  Number.parseInt(manifest.minimum_chrome_version, 10) >= 127,
  "右键菜单使用 action.openPopup，最低版本必须为 Chrome 127"
);
assert.ok(
  !manifest.host_permissions?.length,
  "不得声明永久全站主机权限，应继续使用 optional_host_permissions"
);
assert.deepEqual(
  manifest.optional_permissions,
  ["cookies"],
  "Cookie 必须保持为单独的可选权限"
);

requireFile(manifest.background.service_worker);
requireFile(manifest.action.default_popup);
requireFile(manifest.options_ui.page);

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
for (const iconPath of new Set([
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action.default_icon ?? {})
])) {
  const icon = readFileSync(requireFile(iconPath));
  assert.ok(
    icon.subarray(0, pngSignature.length).equals(pngSignature),
    `${iconPath} 不是有效 PNG 文件`
  );
}

const htmlFiles = collectFiles(resolve(projectRoot, "src"), new Set([".html"]));
htmlFiles.forEach(validateHtmlReferences);

const scriptFiles = [
  ...collectFiles(resolve(projectRoot, "src"), new Set([".js"])),
  ...collectFiles(resolve(projectRoot, "tests"), new Set([".js"])),
  ...collectFiles(resolve(projectRoot, "scripts"), new Set([".mjs"]))
].filter((path) => !path.includes("/src/vendor/"));

for (const scriptPath of scriptFiles) {
  validateModuleImports(scriptPath);
  const syntaxCheck = spawnSync(process.execPath, ["--check", scriptPath], {
    encoding: "utf8"
  });
  assert.equal(
    syntaxCheck.status,
    0,
    `JavaScript 语法检查失败：${scriptPath}\n${syntaxCheck.stderr}`
  );
}

console.log(
  `扩展校验通过：${htmlFiles.length} 个 HTML，${scriptFiles.length} 个 JavaScript，${Object.keys(manifest.icons).length} 个图标。`
);
