import { createChromeMock, loadBrowserScript } from "../helpers/script-loader.js";

describe("background.js", () => {
  it("merges capture status with sensible fallbacks", async () => {
    const { chrome } = createChromeMock();
    const { exports } = await loadBrowserScript("src/background.js", {
      setupWindow(window) {
        window.chrome = chrome;
      }
    });
    const { mergeCaptureStatus } = exports.background;

    const merged = mergeCaptureStatus(
      {
        ready: false,
        connectedAt: 1,
        lastReadyAt: 2,
        lastStatusAt: 3,
        lastSnapshotAt: 4,
        lastExtractorStage: "old-stage",
        lastExtractorMessage: "old-message",
        lastError: "old-error",
        pageKind: "sheet-shell",
        pageSupported: null,
        lastSupportReason: "old-reason",
        pageTitle: " Old Title ",
        url: "https://old.example.com",
        pageSessionKey: "session-1"
      },
      {
        ready: true,
        lastStatusAt: 30,
        lastExtractorStage: " new-stage ",
        lastExtractorMessage: " new-message ",
        lastError: "",
        pageSupported: true,
        supportReason: " new-reason ",
        pageTitle: " New Title ",
        url: "https://new.example.com",
        pageSessionKey: " session-2 "
      }
    );

    expect(merged).toEqual({
      ready: true,
      connectedAt: 1,
      lastReadyAt: 2,
      lastStatusAt: 30,
      lastSnapshotAt: 4,
      lastExtractorStage: "new-stage",
      lastExtractorMessage: "new-message",
      lastError: "",
      pageKind: "sheet-shell",
      pageSupported: true,
      lastSupportReason: "new-reason",
      pageTitle: "New Title",
      url: "https://new.example.com",
      pageSessionKey: "session-2"
    });
  });

  it("persists snapshot and capture status when receiving CELL_SNAPSHOT", async () => {
    const { chrome, listeners, storage } = createChromeMock();
    const { exports } = await loadBrowserScript("src/background.js", {
      setupWindow(window) {
        window.chrome = chrome;
      }
    });

    exports.background.initializeBackgroundRuntime();

    const sendResponse = vi.fn();
    const handled = listeners.message[0](
      {
        type: "CELL_SNAPSHOT",
        payload: {
          cellRef: "B12",
          rawContent: "hello",
          source: "formula-bar",
          pageTitle: "Test Sheet",
          url: "https://example.feishu.cn/sheets/123",
          pageSessionKey: "session-4",
          pageKind: "sheet-ready",
          pageSupported: true,
          supportReason: "supported",
          extractorStage: "hit:formula-bar",
          extractorMessage: "captured"
        }
      },
      { tab: { id: 42 } },
      sendResponse
    );

    expect(handled).toBe(true);

    const snapshotKey = exports.background.getSnapshotKey(42);
    const statusKey = exports.background.getCaptureStatusKey(42);

    expect(storage[snapshotKey]).toMatchObject({
      tabId: 42,
      cellRef: "B12",
      rawContent: "hello",
      source: "formula-bar",
      pageTitle: "Test Sheet",
      url: "https://example.feishu.cn/sheets/123",
      pageSessionKey: "session-4"
    });
    expect(storage[snapshotKey].capturedAt).toEqual(expect.any(Number));

    expect(storage[statusKey]).toMatchObject({
      ready: true,
      lastSnapshotAt: storage[snapshotKey].capturedAt,
      lastStatusAt: storage[snapshotKey].capturedAt,
      lastExtractorStage: "hit:formula-bar",
      lastExtractorMessage: "captured",
      pageKind: "sheet-ready",
      pageSupported: true,
      lastSupportReason: "supported",
      pageSessionKey: "session-4"
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("injects content scripts into already open Feishu tabs on install", async () => {
    const { chrome, listeners } = createChromeMock({
      tabsData: [
        { id: 1, url: "https://tenant.feishu.cn/sheets/1" },
        { id: 2, url: "https://example.com/docs" },
        { id: 3, url: "https://foo.larksuite.com/base/1" }
      ]
    });
    const { exports } = await loadBrowserScript("src/background.js", {
      setupWindow(window) {
        window.chrome = chrome;
      }
    });

    exports.background.initializeBackgroundRuntime();
    listeners.installed[0]();

    expect(chrome.tabs.query).toHaveBeenCalledWith({}, expect.any(Function));
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 1 },
      files: ["src/content-script.js"]
    });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 3 },
      files: ["src/content-script.js"]
    });
  });

  it("injects a content script into a requested tab when receiving ENSURE_CONTENT_SCRIPT", async () => {
    const { chrome, listeners } = createChromeMock();
    const { exports } = await loadBrowserScript("src/background.js", {
      setupWindow(window) {
        window.chrome = chrome;
      }
    });

    exports.background.initializeBackgroundRuntime();

    const sendResponse = vi.fn();
    let handled = false;
    await new Promise((resolve) => {
      handled = listeners.message[0](
        {
          type: "ENSURE_CONTENT_SCRIPT",
          payload: {
            tabId: 55
          }
        },
        {},
        (response) => {
          sendResponse(response);
          resolve();
        }
      );
    });

    expect(handled).toBe(true);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 55 },
      files: ["src/content-script.js"]
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});
