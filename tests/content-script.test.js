import { createChromeMock, loadBrowserScript, setVisibleRect } from "./helpers/script-loader.js";

describe("content-script.js", () => {
  function loadContentScript({ html, url = "https://tenant.feishu.cn/sheets/mock" } = {}) {
    const { chrome } = createChromeMock();

    return loadBrowserScript("content-script.js", {
      html: html || "<!doctype html><html><body></body></html>",
      url,
      setupWindow(window) {
        window.chrome = chrome;
      }
    }).then((context) => ({
      ...context,
      chrome
    }));
  }

  function appendReadySheetDom(window, { cellRef = "B12", rawContent = "Revenue" } = {}) {
    const nameBox = window.document.createElement("input");
    nameBox.setAttribute("aria-label", "name box");
    nameBox.value = cellRef;
    setVisibleRect(nameBox, { top: 16, left: 16, width: 80, height: 28 });

    const formula = window.document.createElement("textarea");
    formula.setAttribute("aria-label", "formula");
    formula.value = rawContent;
    setVisibleRect(formula, { top: 16, left: 120, width: 300, height: 36 });

    const selectedCell = window.document.createElement("div");
    selectedCell.setAttribute("role", "gridcell");
    selectedCell.setAttribute("aria-selected", "true");
    selectedCell.setAttribute("aria-rowindex", "12");
    selectedCell.setAttribute("aria-colindex", "2");
    selectedCell.textContent = rawContent;
    setVisibleRect(selectedCell, { top: 200, left: 80, width: 100, height: 30 });

    window.document.body.append(nameBox, formula, selectedCell);
  }

  it("parses cell references and derives coordinates", async () => {
    const { exports } = await loadContentScript();
    const runtime = exports.contentScript.createSheetMateContentScriptRuntime({ skipAutoStart: true });

    expect(runtime.parseCellReference("A1")).toEqual({ row: 1, col: 1 });
    expect(runtime.parseCellReference("Z9")).toEqual({ row: 9, col: 26 });
    expect(runtime.parseCellReference("AA10")).toEqual({ row: 10, col: 27 });
    expect(runtime.parseCellReference("ABC123")).toEqual({ row: 123, col: 731 });
    expect(runtime.columnNumberToName(731)).toBe("ABC");
  });

  it("derives cell references from attributes and coordinate metadata", async () => {
    const { window, exports } = await loadContentScript();
    const runtime = exports.contentScript.createSheetMateContentScriptRuntime({ skipAutoStart: true });

    const direct = window.document.createElement("div");
    direct.setAttribute("data-testid", "cell-B12");
    setVisibleRect(direct);
    window.document.body.appendChild(direct);

    const indexed = window.document.createElement("div");
    indexed.setAttribute("aria-rowindex", "7");
    indexed.setAttribute("aria-colindex", "28");
    setVisibleRect(indexed);
    window.document.body.appendChild(indexed);

    expect(runtime.deriveCellReference(direct)).toBe("B12");
    expect(runtime.deriveCellReference(indexed)).toBe("AB7");
  });

  it("detects unsupported, shell, and ready page states", async () => {
    const unsupportedContext = await loadContentScript({
      url: "https://tenant.feishu.cn/wiki/mock"
    });
    const unsupportedRuntime = unsupportedContext.exports.contentScript.createSheetMateContentScriptRuntime({
      skipAutoStart: true
    });
    expect(unsupportedRuntime.detectPageSupport()).toMatchObject({
      pageKind: "unsupported-page",
      pageSupported: false
    });

    const shellContext = await loadContentScript();
    const toolbar = shellContext.window.document.createElement("div");
    toolbar.setAttribute("role", "toolbar");
    setVisibleRect(toolbar, { width: 500, height: 40 });
    shellContext.window.document.body.appendChild(toolbar);
    const shellRuntime = shellContext.exports.contentScript.createSheetMateContentScriptRuntime({
      skipAutoStart: true
    });
    expect(shellRuntime.detectPageSupport()).toMatchObject({
      pageKind: "sheet-shell",
      pageSupported: true
    });

    const readyContext = await loadContentScript();
    const nameBox = readyContext.window.document.createElement("input");
    nameBox.setAttribute("aria-label", "name box");
    nameBox.value = "B12";
    setVisibleRect(nameBox, { top: 20, left: 20, width: 90, height: 28 });

    const formula = readyContext.window.document.createElement("textarea");
    formula.setAttribute("aria-label", "formula");
    formula.value = "=SUM(A1:A3)";
    setVisibleRect(formula, { top: 20, left: 140, width: 320, height: 40 });

    readyContext.window.document.body.append(nameBox, formula);

    const readyRuntime = readyContext.exports.contentScript.createSheetMateContentScriptRuntime({
      skipAutoStart: true
    });
    expect(readyRuntime.detectPageSupport()).toMatchObject({
      pageKind: "sheet-ready",
      pageSupported: true
    });
  });

  it("builds snapshots from name box, formula bar, and active cell signals", async () => {
    const { window, exports } = await loadContentScript();
    window.document.title = "Budget - 飞书";
    appendReadySheetDom(window);

    const runtime = exports.contentScript.createSheetMateContentScriptRuntime({ skipAutoStart: true });
    const result = runtime.readCellSnapshot();

    expect(result.snapshot).toMatchObject({
      cellRef: "B12",
      rawContent: "Revenue",
      source: "name-box+formula-bar",
      pageKind: "sheet-ready",
      pageSupported: true,
      pageSessionKey: "",
      pageTitle: "Budget",
      url: "https://tenant.feishu.cn/sheets/mock"
    });
    expect(result.status).toMatchObject({
      stage: "hit:name-box+formula-bar",
      pageKind: "sheet-ready",
      pageSupported: true
    });
    expect(result.status.message).toContain("B12");
  });

  it("re-sends ready and snapshot when pushState enters a new sheet with the same selected cell", async () => {
    vi.useFakeTimers();

    try {
      const { window, exports, chrome } = await loadContentScript();
      window.document.title = "Budget - 飞书";
      appendReadySheetDom(window);

      const runtime = exports.contentScript.createSheetMateContentScriptRuntime({ skipAutoStart: true });
      runtime.start();

      vi.advanceTimersByTime(200);
      chrome.runtime.sendMessage.mockClear();

      window.history.pushState({}, "", "/sheets/next-sheet");
      window.document.title = "Budget Copy - 飞书";
      vi.advanceTimersByTime(1200);

      const readyCalls = chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.type === "CONTENT_SCRIPT_READY");
      const snapshotCalls = chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.type === "CELL_SNAPSHOT");

      expect(readyCalls.length).toBeGreaterThan(0);
      expect(readyCalls.at(-1)?.[0]?.payload?.url).toBe("https://tenant.feishu.cn/sheets/next-sheet");
      expect(readyCalls.at(-1)?.[0]?.payload?.pageSessionKey).toBe("session-3");
      expect(snapshotCalls.length).toBeGreaterThan(0);
      expect(snapshotCalls.at(-1)?.[0]?.payload).toMatchObject({
        cellRef: "B12",
        rawContent: "Revenue",
        url: "https://tenant.feishu.cn/sheets/next-sheet",
        pageSessionKey: "session-3",
        pageTitle: "Budget Copy"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-captures after replaceState and popstate route changes", async () => {
    vi.useFakeTimers();

    try {
      const { window, exports, chrome } = await loadContentScript();
      appendReadySheetDom(window, { cellRef: "C7", rawContent: "42" });

      const runtime = exports.contentScript.createSheetMateContentScriptRuntime({ skipAutoStart: true });
      runtime.start();

      vi.advanceTimersByTime(200);
      chrome.runtime.sendMessage.mockClear();

      window.history.replaceState({}, "", "/sheets/replaced-sheet");
      vi.advanceTimersByTime(1200);

      expect(
        chrome.runtime.sendMessage.mock.calls.some(
          ([message]) => message.type === "CELL_SNAPSHOT" && message.payload.url === "https://tenant.feishu.cn/sheets/replaced-sheet"
        )
      ).toBe(true);

      chrome.runtime.sendMessage.mockClear();
      window.history.pushState({}, "", "/sheets/future-sheet");
      vi.advanceTimersByTime(1200);
      chrome.runtime.sendMessage.mockClear();

      window.history.back();
      vi.advanceTimersByTime(1200);

      expect(
        chrome.runtime.sendMessage.mock.calls.some(
          ([message]) => message.type === "CELL_SNAPSHOT" && message.payload.url === "https://tenant.feishu.cn/sheets/replaced-sheet"
        )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates a new page session when history state changes without changing the url", async () => {
    vi.useFakeTimers();

    try {
      const { window, exports, chrome } = await loadContentScript();
      appendReadySheetDom(window, { cellRef: "D9", rawContent: "Pinned" });

      const runtime = exports.contentScript.createSheetMateContentScriptRuntime({ skipAutoStart: true });
      runtime.start();

      vi.advanceTimersByTime(200);
      chrome.runtime.sendMessage.mockClear();

      window.history.replaceState({ sheetId: "sheet-2" }, "", window.location.href);
      vi.advanceTimersByTime(1200);

      const readyCall = chrome.runtime.sendMessage.mock.calls.find(([message]) => message.type === "CONTENT_SCRIPT_READY");
      const snapshotCall = chrome.runtime.sendMessage.mock.calls.find(([message]) => message.type === "CELL_SNAPSHOT");

      expect(readyCall?.[0]?.payload).toMatchObject({
        url: "https://tenant.feishu.cn/sheets/mock",
        pageSessionKey: "session-2"
      });
      expect(snapshotCall?.[0]?.payload).toMatchObject({
        cellRef: "D9",
        rawContent: "Pinned",
        pageSessionKey: "session-2"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates a new page session on title changes detected during capture", async () => {
    const { window, exports, chrome } = await loadContentScript();
    appendReadySheetDom(window, { cellRef: "E4", rawContent: "Headline" });
    window.document.title = "Sheet A - 飞书";

    const runtime = exports.contentScript.createSheetMateContentScriptRuntime({ skipAutoStart: true });
    runtime.start();

    chrome.runtime.sendMessage.mockClear();
    window.document.title = "Sheet B - 飞书";

    runtime.captureAndSendSnapshot();

    const readyCall = chrome.runtime.sendMessage.mock.calls.find(([message]) => message.type === "CONTENT_SCRIPT_READY");
    const snapshotCall = chrome.runtime.sendMessage.mock.calls.find(([message]) => message.type === "CELL_SNAPSHOT");

    expect(readyCall?.[0]?.payload).toMatchObject({
      pageTitle: "Sheet B",
      pageSessionKey: "session-2"
    });
    expect(snapshotCall?.[0]?.payload).toMatchObject({
      pageTitle: "Sheet B",
      pageSessionKey: "session-2"
    });
  });
});
