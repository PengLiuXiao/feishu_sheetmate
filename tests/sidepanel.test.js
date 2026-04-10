import { loadBrowserScript, readRepoFile } from "./helpers/script-loader.js";

describe("sidepanel.js", () => {
  function loadSidepanel() {
    const chrome = {
      runtime: { lastError: null, sendMessage: vi.fn((message, callback) => callback?.({ ok: true })) },
      storage: { onChanged: { addListener() {} }, session: { set() {}, get() {} } },
      tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
      windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener() {} } }
    };

    return loadBrowserScript("sidepanel.js", {
      html: readRepoFile("sidepanel.html"),
      url: "https://example.feishu.cn/sidepanel.html",
      setupWindow(window) {
        window.chrome = chrome;
      }
    }).then((context) => ({
      ...context,
      chrome
    }));
  }

  it("infers content kinds in auto mode", async () => {
    const { exports } = await loadSidepanel();
    const { inferContentKind } = exports.sidepanel;

    expect(inferContentKind('{"name":"sheetmate"}', "auto").kind).toBe("json");
    expect(inferContentKind("# Title", "auto").kind).toBe("markdown");
    expect(inferContentKind("\\frac{1}{2}", "auto").kind).toBe("latex");
    expect(inferContentKind("plain text", "auto").kind).toBe("text");
    expect(inferContentKind("https://cdn.example.com/demo.png", "auto").kind).toBe("media");
  });

  it("recognizes media URLs including blocked platform videos and Feishu assets", async () => {
    const { exports } = await loadSidepanel();
    const { extractMediaItems, resolveMediaItem } = exports.sidepanel;

    expect(resolveMediaItem("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toMatchObject({
      type: "platform_video_blocked",
      provider: "youtube"
    });

    expect(resolveMediaItem("https://www.bilibili.com/video/BV1xx411c7mD")).toMatchObject({
      type: "platform_video_blocked",
      provider: "bilibili"
    });

    expect(
      resolveMediaItem("https://example.feishu.cn/space/api/box/stream/download/all/123?filename=cover.png")
    ).toMatchObject({
      type: "image"
    });

    expect(
      extractMediaItems("![preview](https://cdn.example.com/video.mp4) https://cdn.example.com/cover.jpg")
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "video" }),
        expect.objectContaining({ type: "image" })
      ])
    );
  });

  it("falls back safely when merging invalid panel state", async () => {
    const { exports } = await loadSidepanel();
    const { mergeState } = exports.sidepanel;

    const merged = mergeState({
      layout: "bad-layout",
      activePaneId: "paneB",
      panes: {
        paneA: {
          mode: "markdown",
          snapshot: {
            cellRef: " A1 ",
            rawContent: 123,
            source: " formula-bar ",
            pageTitle: " Demo ",
            url: "https://example.feishu.cn/sheets/1",
            pageSessionKey: " session-1 ",
            capturedAt: 111,
            tabId: 9
          }
        },
        paneB: {
          mode: "bad-mode",
          snapshot: {
            rawContent: "value"
          }
        }
      }
    });

    expect(merged.layout).toBe("single");
    expect(merged.activePaneId).toBe("paneA");
    expect(merged.panes.paneA.mode).toBe("markdown");
    expect(merged.panes.paneA.snapshot).toMatchObject({
      cellRef: "A1",
      rawContent: "123",
      source: "formula-bar",
      pageTitle: "Demo",
      pageSessionKey: "session-1",
      tabId: 9
    });
    expect(merged.panes.paneB.mode).toBe("auto");
    expect(merged.panes.paneB.snapshot).toMatchObject({
      rawContent: "value",
      source: "unknown"
    });
  });

  it("renders blocked platform videos with warning copy and external link", async () => {
    const { exports } = await loadSidepanel();
    const { renderPreview } = exports.sidepanel;

    const node = renderPreview(
      {
        cellRef: "C3",
        rawContent: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        pageTitle: "Demo Sheet"
      },
      "auto"
    );

    expect(node.querySelector(".warning-card")?.textContent).toContain("不直接播放");
    expect(node.textContent).toContain("YouTube");
    expect(node.querySelector('a[href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"]')).not.toBeNull();
    expect(node.textContent).toContain("Demo Sheet");
  });

  it("shows a waiting state instead of stale content after entering a new Feishu sheet", async () => {
    const { window, exports } = await loadSidepanel();
    const { setTestRuntimeState, render } = exports.sidepanel;

    setTestRuntimeState({
      currentTab: {
        id: 7,
        url: "https://example.feishu.cn/sheets/new-sheet",
        title: "New Sheet"
      },
      captureStatus: {
        ready: true,
        pageKind: "sheet-ready",
        pageSupported: true,
        url: "https://example.feishu.cn/sheets/new-sheet",
        pageSessionKey: "session-2"
      },
      state: {
        layout: "single",
        activePaneId: "paneA",
        panes: {
          paneA: {
            mode: "auto",
            snapshot: {
              cellRef: "A1",
              rawContent: "Old sheet value",
              source: "formula-bar",
              url: "https://example.feishu.cn/sheets/new-sheet",
              pageTitle: "Old Sheet",
              pageSessionKey: "session-1",
              tabId: 7
            }
          },
          paneB: {
            mode: "auto",
            snapshot: null
          }
        }
      }
    });

    render();

    const paneContent = window.document.querySelector('[data-pane-id="paneA"] .pane__content');
    expect(paneContent?.textContent).toContain("正在等待新表格的当前选区");
    expect(paneContent?.textContent).not.toContain("Old sheet value");
  });

  it("keeps waiting in supported-shell when the page session already moved to a new sheet", async () => {
    const { window, exports } = await loadSidepanel();
    const { setTestRuntimeState, render } = exports.sidepanel;

    setTestRuntimeState({
      currentTab: {
        id: 7,
        url: "https://example.feishu.cn/sheets/new-sheet",
        title: "New Sheet"
      },
      captureStatus: {
        ready: true,
        pageKind: "sheet-shell",
        pageSupported: true,
        url: "https://example.feishu.cn/sheets/new-sheet",
        pageSessionKey: "session-3"
      },
      state: {
        layout: "single",
        activePaneId: "paneA",
        panes: {
          paneA: {
            mode: "auto",
            snapshot: {
              cellRef: "A1",
              rawContent: "Old shell value",
              source: "formula-bar",
              url: "https://example.feishu.cn/sheets/new-sheet",
              pageTitle: "Old Sheet",
              pageSessionKey: "session-2",
              tabId: 7
            }
          },
          paneB: {
            mode: "auto",
            snapshot: null
          }
        }
      }
    });

    render();

    const paneContent = window.document.querySelector('[data-pane-id="paneA"] .pane__content');
    expect(paneContent?.textContent).toContain("正在等待新表格的当前选区");
    expect(paneContent?.textContent).not.toContain("Old shell value");
  });

  it("keeps showing the previous snapshot when the current page is not a Feishu sheet", async () => {
    const { window, exports } = await loadSidepanel();
    const { setTestRuntimeState, render } = exports.sidepanel;

    setTestRuntimeState({
      currentTab: {
        id: 7,
        url: "https://example.com/docs",
        title: "External Page"
      },
      captureStatus: null,
      state: {
        layout: "single",
        activePaneId: "paneA",
        panes: {
          paneA: {
            mode: "auto",
            snapshot: {
              cellRef: "B2",
              rawContent: "Keep this preview",
              source: "formula-bar",
              url: "https://example.feishu.cn/sheets/old-sheet",
              pageTitle: "Old Sheet",
              pageSessionKey: "session-1",
              tabId: 7
            }
          },
          paneB: {
            mode: "auto",
            snapshot: null
          }
        }
      }
    });

    render();

    const paneContent = window.document.querySelector('[data-pane-id="paneA"] .pane__content');
    expect(paneContent?.textContent).toContain("Keep this preview");
  });

  it("requests content script injection once when the current Feishu tab is not ready", async () => {
    const { exports, chrome } = await loadSidepanel();
    const { setTestRuntimeState, render } = exports.sidepanel;

    setTestRuntimeState({
      currentTab: {
        id: 21,
        url: "https://example.feishu.cn/sheets/21",
        title: "Sheet 21"
      },
      captureStatus: null
    });

    render();
    render();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      {
        type: "ENSURE_CONTENT_SCRIPT",
        payload: { tabId: 21 }
      },
      expect.any(Function)
    );
  });

  it("does not request content script injection for non-Feishu tabs", async () => {
    const { exports, chrome } = await loadSidepanel();
    const { setTestRuntimeState, render } = exports.sidepanel;

    setTestRuntimeState({
      currentTab: {
        id: 88,
        url: "https://example.com/page",
        title: "External"
      },
      captureStatus: null
    });

    render();

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
