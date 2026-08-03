import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_MENU_IDS,
  getContextMenuDefinition,
  getContextMenuTitle,
  isRecognitionConfirmationEnabled
} from "../src/shared/settings-policy.js";

test("关闭识别确认时使用统一发送菜单", () => {
  const settings = { recognizeBeforeDownload: false };
  assert.equal(isRecognitionConfirmationEnabled(settings), false);
  assert.equal(getContextMenuTitle(settings), "发送到 MoviePilot");
  assert.deepEqual(getContextMenuDefinition(settings), {
    id: CONTEXT_MENU_IDS.DIRECT_SEND,
    title: "发送到 MoviePilot",
    requiresConfirmation: false
  });
});

test("开启识别只改变菜单 ID 和确认策略", () => {
  assert.equal(
    getContextMenuTitle({ recognizeBeforeDownload: true }),
    "发送到 MoviePilot"
  );
  assert.deepEqual(
    getContextMenuDefinition({ recognizeBeforeDownload: true }),
    {
      id: CONTEXT_MENU_IDS.RECOGNIZE_SEND,
      title: "发送到 MoviePilot",
      requiresConfirmation: true
    }
  );
  assert.equal(
    getContextMenuTitle({ recognizeBeforeDownload: "false" }),
    "发送到 MoviePilot"
  );
});
