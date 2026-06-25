import { createChromeMock, loadBrowserScript, setVisibleRect } from "../helpers/script-loader.js";

describe("content-script.js", () => {
  function loadContentScript({ html, url = "https://tenant.feishu.cn/sheets/mock" } = {}) {
    const { chrome } = createChromeMock();

    return loadBrowserScript("src/content-script.js", {
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

  it("captures wiki embedded sheets with unlabeled name boxes and Feishu formula bar classes", async () => {
    const { window, exports } = await loadContentScript({
      url: "https://tenant.feishu.cn/wiki/mock"
    });
    window.document.title = "\u200b测试 - 飞书云文档";

    const toolbar = window.document.createElement("div");
    toolbar.setAttribute("role", "toolbar");
    toolbar.textContent = "菜单 撤销 重做 插入 查找和替换";
    setVisibleRect(toolbar, { top: 12, left: 0, width: 600, height: 36 });

    const nameBox = window.document.createElement("input");
    nameBox.value = "A11";
    setVisibleRect(nameBox, { top: 72, left: 16, width: 74, height: 28 });

    const formula = window.document.createElement("div");
    formula.className = "formulabar__inputarea simple-text-editor";
    formula.textContent = "#你是谁\n\n##你好搞笑啊";
    setVisibleRect(formula, { top: 72, left: 112, width: 360, height: 48 });

    window.document.body.append(toolbar, nameBox, formula);

    const runtime = exports.contentScript.createSheetMateContentScriptRuntime({ skipAutoStart: true });
    expect(runtime.detectPageSupport()).toMatchObject({
      pageKind: "sheet-ready",
      pageSupported: true
    });

    const result = runtime.readCellSnapshot();
    expect(result.snapshot).toMatchObject({
      cellRef: "A11",
      rawContent: "#你是谁\n\n##你好搞笑啊",
      source: "name-box+formula-bar",
      pageTitle: "测试",
      url: "https://tenant.feishu.cn/wiki/mock"
    });
  });

  it("does not emit page noise when no current cell signal exists", async () => {
    const { window, exports } = await loadContentScript();

    const toolbar = window.document.createElement("div");
    toolbar.setAttribute("role", "toolbar");
    toolbar.textContent = "菜单 撤销 重做 插入 查找和替换";
    setVisibleRect(toolbar, { top: 12, left: 0, width: 600, height: 36 });

    const sidebarNoise = window.document.createElement("textarea");
    sidebarNoise.value = "飞书云文档\n知识库\n加载中...\nMonica\nCodex";
    setVisibleRect(sidebarNoise, { top: 620, left: 10, width: 300, height: 100 });

    window.document.body.append(toolbar, sidebarNoise);

    const runtime = exports.contentScript.createSheetMateContentScriptRuntime({ skipAutoStart: true });
    const result = runtime.readCellSnapshot();

    expect(result.snapshot).toBeNull();
    expect(result.status).toMatchObject({
      stage: "miss:no-capture-source",
      pageKind: "sheet-shell"
    });
  });

  it("does not bind import-loading page noise to an empty A1 selection", async () => {
    const { window, exports } = await loadContentScript({
      url: "https://tenant.feishu.cn/sheets/mock?sheet=FMIgKF"
    });

    const toolbar = window.document.createElement("div");
    toolbar.setAttribute("role", "toolbar");
    toolbar.textContent = "菜单 撤销 重做 插入 查找和替换";
    setVisibleRect(toolbar, { top: 12, left: 0, width: 600, height: 36 });

    const nameBox = window.document.createElement("input");
    nameBox.value = "A1";
    setVisibleRect(nameBox, { top: 72, left: 16, width: 74, height: 28 });

    const formula = window.document.createElement("div");
    formula.className = "formulabar__inputarea simple-text-editor";
    formula.textContent = "";
    setVisibleRect(formula, { top: 72, left: 112, width: 360, height: 48 });

    const importerNoise = window.document.createElement("div");
    importerNoise.setAttribute("role", "textbox");
    importerNoise.textContent = [
      "上传中 0/1",
      "导入中...",
      "sheet-rendering-cases.csv",
      "飞书云文档",
      "搜索",
      "主页",
      "知识库",
      "Sheet1",
      "Sheet2",
      "菜单",
      "通用项目管理"
    ].join("\n");
    setVisibleRect(importerNoise, { top: 160, left: 0, width: 900, height: 520 });

    window.document.body.append(toolbar, nameBox, formula, importerNoise);

    const runtime = exports.contentScript.createSheetMateContentScriptRuntime({ skipAutoStart: true });
    expect(runtime.detectPageSupport()).toMatchObject({
      pageKind: "sheet-shell",
      pageSupported: true
    });

    const result = runtime.readCellSnapshot();
    expect(result.snapshot).toMatchObject({
      cellRef: "A1",
      rawContent: "",
      source: "name-box+formula-bar+empty-cell"
    });
    expect(result.status).toMatchObject({
      stage: "hit:name-box+formula-bar+empty-cell",
      pageKind: "sheet-ready"
    });
    expect(result.snapshot.rawContent).not.toContain("飞书云文档");
    expect(result.snapshot.rawContent).not.toContain("导入中");
  });

  it("ignores page noise when a real current cell signal exists", async () => {
    const { window, exports } = await loadContentScript();

    const sidebarNoise = window.document.createElement("textarea");
    sidebarNoise.value = "飞书云文档\n知识库\n加载中...\nMonica\nCodex";
    setVisibleRect(sidebarNoise, { top: 620, left: 10, width: 300, height: 100 });
    window.document.body.appendChild(sidebarNoise);
    appendReadySheetDom(window, { cellRef: "A7", rawContent: "第一行\n第二行" });

    const runtime = exports.contentScript.createSheetMateContentScriptRuntime({ skipAutoStart: true });
    const result = runtime.readCellSnapshot();

    expect(result.snapshot).toMatchObject({
      cellRef: "A7",
      rawContent: "第一行\n第二行"
    });
    expect(result.snapshot.rawContent).not.toContain("飞书云文档");
    expect(result.snapshot.rawContent).not.toContain("加载中");
  });

  it("sends an empty snapshot after moving from media content to a blank cell", async () => {
    const { window, exports, chrome } = await loadContentScript();
    const nameBox = window.document.createElement("input");
    nameBox.value = "J16";
    setVisibleRect(nameBox, { top: 72, left: 16, width: 74, height: 28 });

    const formula = window.document.createElement("div");
    formula.className = "formulabar__inputarea simple-text-editor";
    formula.textContent = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
    setVisibleRect(formula, { top: 72, left: 112, width: 360, height: 48 });

    window.document.body.append(nameBox, formula);

    const runtime = exports.contentScript.createSheetMateContentScriptRuntime({ skipAutoStart: true });
    runtime.captureAndSendSnapshot();

    nameBox.value = "E13";
    formula.textContent = "";
    runtime.captureAndSendSnapshot();

    const snapshotCalls = chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.type === "CELL_SNAPSHOT");
    expect(snapshotCalls).toHaveLength(2);
    expect(snapshotCalls[0][0].payload).toMatchObject({
      cellRef: "J16",
      rawContent: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
    });
    expect(snapshotCalls[1][0].payload).toMatchObject({
      cellRef: "E13",
      rawContent: "",
      source: "name-box+formula-bar+empty-cell"
    });
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
