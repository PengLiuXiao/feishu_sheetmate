import { loadBrowserScript, readRepoFile } from "../helpers/script-loader.js";

describe("sidepanel.js", () => {
  function loadSidepanel() {
    const chrome = {
      runtime: { lastError: null, sendMessage: vi.fn((message, callback) => callback?.({ ok: true })) },
      storage: { onChanged: { addListener() {} }, session: { set() {}, get() {} } },
      tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
      windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener() {} } }
    };

    return loadBrowserScript("src/sidepanel/sidepanel.js", {
      html: readRepoFile("src/sidepanel/sidepanel.html"),
      url: "https://example.feishu.cn/src/sidepanel/sidepanel.html",
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

  it("keeps the online rendering regression CSV dataset complete", () => {
    const csv = readRepoFile("tests/fixtures/sheet-rendering-cases.csv");
    const caseIds = Array.from(csv.matchAll(/^T\d{3},/gm)).map((match) => match[0].slice(0, -1));

    expect(csv.startsWith("case_id,category,expected_auto_mode,expected_result,cell_content\n")).toBe(true);
    expect(caseIds).toHaveLength(25);
    expect(caseIds).toEqual(Array.from({ length: 25 }, (_, index) => `T${String(index + 1).padStart(3, "0")}`));
    expect(csv).toContain("T017,youtube_watch");
    expect(csv).toContain("T021,mixed_text_video");
  });

  it("renders the minimal toolbar and keeps layout and mode controls", async () => {
    const { window } = await loadSidepanel();

    expect(window.document.querySelector(".toolbar__title")?.textContent).toBe("预览");
    expect(Array.from(window.document.querySelectorAll(".layout-switch__button")).map((button) => button.textContent)).toEqual([
      "单",
      "左/右",
      "上/下"
    ]);
    expect(window.document.getElementById("statusbar")).toBeNull();

    const modeSelects = window.document.querySelectorAll(".mode-select");
    expect(modeSelects).toHaveLength(2);
    expect(Array.from(modeSelects[0].querySelectorAll("option")).map((option) => option.textContent)).toEqual([
      "自动",
      "文本",
      "Markdown",
      "JSON",
      "LaTeX",
      "媒体"
    ]);
  });

  it("keeps columns and rows as distinct layouts in the side panel", async () => {
    const { window, exports } = await loadSidepanel();
    const board = window.document.getElementById("board");
    const { setTestRuntimeState, render } = exports.sidepanel;
    const stylesheet = readRepoFile("src/sidepanel/sidepanel.css");

    expect(stylesheet).toContain('.board[data-layout="columns"] {\n  grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(stylesheet).toContain('@media (max-width: 900px) {\n  .board[data-layout="columns"] {\n    grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(stylesheet).toContain('.board[data-layout="rows"] {\n  grid-template-columns: 1fr;\n  grid-template-rows: repeat(2, minmax(220px, 1fr));');

    setTestRuntimeState({ state: { layout: "columns" } });
    render();
    expect(board?.dataset.layout).toBe("columns");

    setTestRuntimeState({ state: { layout: "rows" } });
    render();
    expect(board?.dataset.layout).toBe("rows");

    setTestRuntimeState({ state: { layout: "single" } });
    render();
    expect(board?.dataset.layout).toBe("single");
  });

  it("highlights only the active pane with a follow ring", async () => {
    const { window, exports } = await loadSidepanel();
    const { setTestRuntimeState, render } = exports.sidepanel;

    setTestRuntimeState({
      currentTab: {
        id: 12,
        url: "https://example.feishu.cn/sheets/12",
        title: "Sheet 12"
      },
      captureStatus: {
        ready: true,
        pageKind: "sheet-ready",
        pageSupported: true,
        url: "https://example.feishu.cn/sheets/12",
        pageSessionKey: "session-12"
      },
      state: {
        layout: "columns",
        activePaneId: "paneA",
        panes: {
          paneA: {
            mode: "auto",
            snapshot: null
          },
          paneB: {
            mode: "auto",
            snapshot: null
          }
        }
      }
    });

    render();

    const paneA = window.document.querySelector('[data-pane-id="paneA"]');
    const paneB = window.document.querySelector('[data-pane-id="paneB"]');
    expect(paneA?.classList.contains("is-active")).toBe(true);
    expect(paneB?.classList.contains("is-active")).toBe(false);

    setTestRuntimeState({
      state: {
        layout: "columns",
        activePaneId: "paneB",
        panes: {
          paneA: {
            mode: "auto",
            snapshot: null
          },
          paneB: {
            mode: "auto",
            snapshot: null
          }
        }
      }
    });

    render();

    expect(paneA?.classList.contains("is-active")).toBe(false);
    expect(paneB?.classList.contains("is-active")).toBe(true);
  });

  it("uses a visible ring style for the active pane", async () => {
    const stylesheet = readRepoFile("src/sidepanel/sidepanel.css");

    expect(stylesheet).toContain("--focus-ring: #111418;");
    expect(stylesheet).toContain(".pane.is-active {\n  border-color: var(--focus-ring);");
    expect(stylesheet).toContain("box-shadow: 0 0 0 1.5px var(--focus-ring), var(--shadow);");
  });

  it("recognizes media URLs including Feishu assets and link fallbacks", async () => {
    const { exports } = await loadSidepanel();
    const { extractMediaItems, resolveMediaItem } = exports.sidepanel;

    expect(resolveMediaItem("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=23s")).toMatchObject({
      type: "embed",
      provider: "YouTube",
      embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ?start=23"
    });

    expect(resolveMediaItem("https://www.bilibili.com/video/BV1xx411c7mD")).toMatchObject({
      type: "embed",
      provider: "Bilibili",
      embedUrl: "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD"
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

  it("recognizes all supported platform video URL variants as embed media", async () => {
    const { exports } = await loadSidepanel();
    const { resolveMediaItem } = exports.sidepanel;

    expect(resolveMediaItem("https://www.youtube.com/watch?v=jm2jBW462bU&t=23s")).toMatchObject({
      type: "embed",
      provider: "YouTube",
      embedUrl: "https://www.youtube.com/embed/jm2jBW462bU?start=23"
    });
    expect(resolveMediaItem("https://youtu.be/jm2jBW462bU")).toMatchObject({
      type: "embed",
      provider: "YouTube",
      embedUrl: "https://www.youtube.com/embed/jm2jBW462bU"
    });
    expect(resolveMediaItem("https://www.youtube.com/shorts/jm2jBW462bU")).toMatchObject({
      type: "embed",
      provider: "YouTube",
      embedUrl: "https://www.youtube.com/embed/jm2jBW462bU"
    });
    expect(resolveMediaItem("https://www.youtube.com/embed/jm2jBW462bU?start=12")).toMatchObject({
      type: "embed",
      provider: "YouTube",
      embedUrl: "https://www.youtube.com/embed/jm2jBW462bU?start=12"
    });
    expect(resolveMediaItem("https://www.bilibili.com/video/av123456")).toMatchObject({
      type: "embed",
      provider: "Bilibili",
      embedUrl: "https://player.bilibili.com/player.html?aid=123456"
    });
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

  it("renders platform video pages inside the panel instead of treating them as plain external links", async () => {
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

    const iframe = node.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.src).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(node.textContent).toContain("可能限制侧边栏内嵌播放");
    expect(node.querySelector(".media-card__action")?.textContent).toBe("打开原页面");
    expect(node.querySelector('a[href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"]')).not.toBeNull();
    expect(node.querySelector(".preview-text")?.textContent || "").not.toContain("Demo Sheet");
  });

  it("renders an empty cell snapshot without stale media", async () => {
    const { exports } = await loadSidepanel();
    const { renderPreview } = exports.sidepanel;

    const node = renderPreview(
      {
        cellRef: "E13",
        rawContent: "",
        source: "name-box+formula-bar+empty-cell",
        pageTitle: "未命名表格"
      },
      "auto"
    );

    expect(node.textContent).toContain("E13");
    expect(node.textContent).toContain("空单元格");
    expect(node.querySelector("video")).toBeNull();
    expect(node.querySelector("iframe")).toBeNull();
    expect(node.querySelector(".media-card__url")).toBeNull();
  });

  it("auto-detects multiline Markdown headings from real Feishu cells", async () => {
    const { exports } = await loadSidepanel();
    const { inferContentKind, renderPreview } = exports.sidepanel;
    const rawContent = "#你是谁\n\n##你好搞笑啊";

    expect(inferContentKind(rawContent, "auto").kind).toBe("markdown");

    const node = renderPreview(
      {
        cellRef: "A7",
        rawContent,
        pageTitle: "未命名表格"
      },
      "auto"
    );

    expect(node.querySelector(".markdown-body h1")?.textContent).toBe("你是谁");
    expect(node.querySelector(".markdown-body h2")?.textContent).toBe("你好搞笑啊");
    expect(node.querySelector(".preview-text")).toBeNull();
  });

  it("keeps multiline plain text line breaks in text mode", async () => {
    const { exports } = await loadSidepanel();
    const { renderPreview } = exports.sidepanel;
    const rawContent = "第一行\n第二行\n第三行";

    const node = renderPreview(
      {
        cellRef: "A3",
        rawContent,
        pageTitle: "测试"
      },
      "text"
    );

    expect(node.querySelector(".preview-text")?.textContent).toBe(rawContent);
  });

  it("renders direct image and video links with native media elements", async () => {
    const { exports } = await loadSidepanel();
    const { renderPreview } = exports.sidepanel;

    const imageNode = renderPreview(
      {
        cellRef: "A14",
        rawContent: "https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg"
      },
      "auto"
    );
    expect(imageNode.querySelector("img")?.src).toBe(
      "https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg"
    );

    const mp4Node = renderPreview(
      {
        cellRef: "A15",
        rawContent: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
      },
      "auto"
    );
    expect(mp4Node.querySelector("video")?.controls).toBe(true);
    expect(mp4Node.querySelector("video")?.src).toBe(
      "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
    );

    const webmNode = renderPreview(
      {
        cellRef: "A16",
        rawContent: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm"
      },
      "auto"
    );
    expect(webmNode.querySelector("video")?.controls).toBe(true);
    expect(webmNode.querySelector("video")?.src).toBe(
      "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm"
    );
  });

  it("keeps surrounding text when a cell mixes text and media links", async () => {
    const { exports } = await loadSidepanel();
    const { renderPreview } = exports.sidepanel;
    const rawContent = "这是一个视频：\nhttps://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4\n结束。";

    const node = renderPreview(
      {
        cellRef: "A21",
        rawContent,
        pageTitle: "测试"
      },
      "auto"
    );

    expect(node.querySelector("video")?.src).toBe(
      "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
    );
    expect(node.textContent).toContain("这是一个视频");
    expect(node.textContent).toContain("结束");
  });

  it("does not leak zero-width title noise into preview body", async () => {
    const { exports } = await loadSidepanel();
    const { renderPreview } = exports.sidepanel;

    const node = renderPreview(
      {
        cellRef: "A1",
        rawContent: "只显示单元格",
        pageTitle: "\u200b\u2060测试 - 飞书云文档"
      },
      "auto"
    );

    expect(node.querySelector(".preview-text")?.textContent).toBe("只显示单元格");
    expect(node.querySelector(".preview-text")?.textContent || "").not.toContain("飞书云文档");
    expect(node.querySelector(".preview-card__meta")?.textContent || "").not.toContain("\u2060");
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
    expect(paneContent?.textContent).toContain("等待当前选区");
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
    expect(paneContent?.textContent).toContain("等待当前选区");
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

  it("compresses meta and empty-state copy in the minimal UI", async () => {
    const { window, exports } = await loadSidepanel();
    const { setTestRuntimeState, render } = exports.sidepanel;

    setTestRuntimeState({
      currentTab: {
        id: 31,
        url: "https://example.feishu.cn/sheets/31",
        title: "Sheet 31"
      },
      captureStatus: {
        ready: true,
        pageKind: "sheet-ready",
        pageSupported: true,
        url: "https://example.feishu.cn/sheets/31",
        pageSessionKey: "session-3"
      },
      state: {
        layout: "single",
        activePaneId: "paneA",
        panes: {
          paneA: {
            mode: "auto",
            snapshot: {
              cellRef: "B2",
              rawContent: "hello",
              source: "formula-bar",
              url: "https://example.feishu.cn/sheets/31",
              pageTitle: "Sheet 31",
              pageSessionKey: "session-3",
              tabId: 31
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

    const meta = window.document.querySelector('[data-pane-id="paneA"] .pane__meta');
    expect(meta?.textContent).toBe("B2 · 纯文本");

    setTestRuntimeState({
      currentTab: {
        id: 31,
        url: "https://example.feishu.cn/sheets/31",
        title: "Sheet 31"
      },
      captureStatus: {
        ready: false
      },
      state: {
        layout: "single",
        activePaneId: "paneA",
        panes: {
          paneA: {
            mode: "auto",
            snapshot: null
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
    expect(paneContent?.textContent).toContain("未连接");
    expect(paneContent?.textContent).not.toContain("如果");
    expect(paneContent?.textContent).not.toContain("通常");
  });
});
