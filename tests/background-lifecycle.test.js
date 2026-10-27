const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto").webcrypto;
const root = path.resolve(__dirname, "..");

function fixture(initialNotes = []) {
  const data = { ytd_notes: structuredClone(initialNotes) };
  const calls = [];
  const events = { addListener() {} };
  let activeTabId = 7;
  let rejectTabClose = true;
  let failWrite = false;
  const context = {
    URL, console, crypto, TextDecoder, TextEncoder, AbortController,
    Date: class extends Date { static now() { return 1000; } },
    setTimeout, clearTimeout, importScripts() {},
    chrome: {
      storage: { local: {
        setAccessLevel: async () => {},
        // Chrome storage returns independent copies, not shared references.
        get: async (key) => structuredClone({ [key]: data[key] }),
        set: async (values) => {
          if (failWrite) { failWrite = false; throw new Error("storage unavailable"); }
          Object.assign(data, structuredClone(values));
        },
      } },
      action: { onClicked: events },
      runtime: { onInstalled: events, onMessage: events, sendMessage: async () => {} },
      tabs: { onUpdated: events, onActivated: events, query: async () => [{ id: activeTabId }] },
      sidePanel: {
        setPanelBehavior() {},
        close: async (options) => {
          calls.push(["close", options]);
          if (options.tabId && rejectTabClose) throw new Error("No tab-specific panel");
        },
        setOptions: async (options) => calls.push(["options", options]),
      },
    },
  };
  context.globalThis = context;
  for (const file of ["settings.js", "background.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  }
  const helpers = context.__YTD_TRANSLATION_TESTING__;
  return {
    ...helpers, data, calls,
    setActive(id) { activeTabId = id; },
    tabCloseSucceeds() { rejectTabClose = false; },
    failNextWrite() { failWrite = true; },
    save(text) { return helpers.handleSaveNote("abcdefghijk", 10, "Video", "Channel", text); },
  };
}

test("simultaneous notes retain both records and unique IDs even within one millisecond", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.save("First note"), f.save("Second note")]);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.notEqual(first.note.id, second.note.id);
  assert.deepEqual(f.data.ytd_notes.map((n) => n.text).sort(), ["First note", "Second note"]);
});

test("concurrent note deletion cannot resurrect a removed note or overwrite a new save", async () => {
  const f = fixture([{ id: "old", text: "Delete me" }]);
  const saved = f.save("Keep me");
  await Promise.all([saved, f.handleDeleteNote("old")]);
  assert.deepEqual(f.data.ytd_notes.map((n) => n.text), ["Keep me"]);
});

test("failed note write does not poison later saves and the newest 100 notes are preserved", async () => {
  const f = fixture(Array.from({ length: 100 }, (_, i) => ({ id: `old-${i}`, text: `Old ${i}` })));
  f.failNextWrite();
  assert.equal((await f.save("Failed")).success, false);
  assert.equal((await f.save("Saved later")).success, true);
  assert.equal(f.data.ytd_notes.length, 100);
  assert.equal(f.data.ytd_notes[0].text, "Saved later");
  assert.equal(f.data.ytd_notes.at(-1).id, "old-98");
});

test("background tab navigation does not close the active video's global side panel", async () => {
  const f = fixture();
  await f.updatePanelForTab(8, "https://example.com/", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [
    ["close", { tabId: 8 }], ["options", { tabId: 8, enabled: false }],
  ]);
});

test("leaving YouTube in the active tab still closes the global panel", async () => {
  const f = fixture();
  await f.updatePanelForTab(7, "https://example.com/", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [
    ["close", { tabId: 7 }], ["close", { windowId: 1 }],
    ["options", { tabId: 7, enabled: false }],
  ]);
});

test("YouTube lookalike origins never enable the panel", async () => {
  for (const url of ["https://www.youtube.com.evil/watch", "https://www.youtube.com@evil.example/watch", "https://www.youtube.com:444/watch"]) {
    const f = fixture();
    await f.updatePanelForTab(7, url, 1);
    assert.equal(f.calls.at(-1)[1].enabled, false);
  }
  const f = fixture();
  await f.updatePanelForTab(7, "https://www.youtube.com/watch?v=abcdefghijk", 1);
  assert.equal(f.calls.at(-1)[1].enabled, true);
});
