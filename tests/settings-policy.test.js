import assert from "node:assert/strict";
import test from "node:test";

import {
  getContextMenuTitle,
  isRecognitionConfirmationEnabled
} from "../src/shared/settings-policy.js";

test("关闭识别确认时菜单明确显示直接发送", () => {
  const settings = { recognizeBeforeDownload: false };
  assert.equal(isRecognitionConfirmationEnabled(settings), false);
  assert.equal(getContextMenuTitle(settings), "直接发送到 MoviePilot");
});

test("只有布尔值 true 才显示识别发送菜单", () => {
  assert.equal(
    getContextMenuTitle({ recognizeBeforeDownload: true }),
    "识别并发送到 MoviePilot"
  );
  assert.equal(
    getContextMenuTitle({ recognizeBeforeDownload: "false" }),
    "直接发送到 MoviePilot"
  );
});
