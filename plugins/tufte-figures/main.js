const {
  MarkdownRenderer,
  Plugin,
  Modal,
  Setting,
  PluginSettingTab,
  Notice
} = require("obsidian");

// Tufte Figures — drop-to-insert Tufte-style figures.
//
// Three display modes, written as portable Markdown and rendered by the
// companion stylesheet in Reading view only (the editor stays single-column,
// matching the Tufte Sidenotes plugin):
//
//   1. Default — image in the text column, caption floated into the margin:
//        > [!figure] Fig. 1.
//        > ![[diagram.png|Alt]]
//        > Caption text.
//
//        ^fig-1
//
//   2. Full-width — image spans column + margin, caption below:
//        > [!figure-full] Fig. 2.
//        > ![[wide.png|Alt]]
//        > Caption text.
//
//        ^fig-2
//
//   3. Margin figure — image and caption both in the margin:
//        > [!figure-margin] Fig. 3.
//        > ![[small.png|Alt]]
//        > Caption text.
//
//        ^fig-3
//
// Each figure carries a `^fig-N` block anchor so the clickable in-text
// indicator `[[#^fig-N|(Fig. N)]]` resolves and scrolls to it.

const ENABLED_CLASS = "tufte-figures-enabled";
const DEFAULT_SETTINGS = {
  interceptDrops: true,
  labelPrefix: "Fig.",
  quiltFolder: "img/quilt"
};

const ANCHOR_LINE_RE = /^\s*\^fig-(\d+)\s*$/;
const CALLOUT_HEADER_RE = /^(\s*>\s*\[!([a-z-]+)\][+-]?)(?:\s+(.*))?$/i;
const BLOCKQUOTE_LINE_RE = /^\s*>\s?(.*)$/;
const IMAGE_MARKDOWN_RE = /^\s*(?:!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\))\s*$/;
// Same image embed, but as a *leading* match so trailing label/caption text
// on the same line can follow (multi-image entry lines).
const IMAGE_LEAD_RE = /^\s*(!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\))\s*(.*)$/;
// `(label) caption` — the order letter in parentheses, then the caption.
const ENTRY_LABEL_RE = /^\(([^)]*)\)\s*(.*)$/;
const FIGURE_CALLOUT_TYPES = new Set([
  "figure",
  "figure-full",
  "figure-margin",
  "marginnote"
]);
const CAPTION_MARKER_RE = /^\s*\[!caption\]\s*/i;

module.exports = class TufteFiguresPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.syncEnabledClass();
    this.register(() => {
      document.body?.classList.remove(ENABLED_CLASS);
      document.documentElement?.classList.remove(ENABLED_CLASS);
    });

    // Keep the enabled class in sync as the active theme changes.
    this.registerEvent(
      this.app.workspace.on("css-change", () => this.syncEnabledClass())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.syncEnabledClass())
    );

    this.addSettingTab(new FigureSettingTab(this.app, this));

    this.addCommand({
      id: "insert-figure",
      name: "Insert figure",
      editorCallback: (editor) => {
        const line = editor.getLine(editor.getCursor().line) || "";
        const m = line.match(/!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\)/);
        new FigureModal(this.app, this, editor, {
          embed: m ? m[0] : "",
          altDefault: "",
          pos: editor.getCursor()
        }).open();
      }
    });

    // Contextual: only available while the cursor sits inside a figure
    // callout. Opens the modal pre-filled with that figure, replacing it on
    // save. Bind a hotkey in Settings → Hotkeys.
    this.addCommand({
      id: "edit-figure",
      name: "Edit figure at cursor",
      editorCheckCallback: (checking, editor) => {
        const found = findFigureAtCursor(editor);
        if (!found) return false;
        if (checking) return true;
        const parsed = parseFigureBlock(found.lines);
        const sourcePath = this.app.workspace.getActiveFile()?.path || "";
        // A single-image figure embedding `quilt-<id>.png` with a saved config
        // sidecar re-opens on the quilt tab; everything else opens as before.
        (async () => {
          let quilt = null;
          if (parsed.images.length === 1) {
            const id = quiltIdFromEmbed(parsed.images[0].embed);
            if (id) {
              const dir = quiltDir(this.app, id);
              try {
                if (await this.app.vault.adapter.exists(`${dir}/config.json`)) {
                  quilt = { id, dir };
                }
              } catch {}
            }
          }
          new FigureModal(this.app, this, editor, {
            edit: parsed,
            editRange: { from: found.start, to: found.end },
            pos: editor.getCursor(),
            sourcePath,
            quilt
          }).open();
        })();
        return true;
      }
    });

    this.addCommand({
      id: "insert-image-quilt",
      name: "Insert image quilt",
      editorCallback: (editor) => {
        new FigureModal(this.app, this, editor, {
          embed: "",
          altDefault: "",
          pos: editor.getCursor(),
          openTab: "quilt",
          sourcePath: this.app.workspace.getActiveFile()?.path || ""
        }).open();
      }
    });

    this.addCommand({
      id: "insert-figure-reference",
      name: "Insert figure reference",
      editorCallback: (editor) => {
        new FigureReferenceModal(this.app, this, editor).open();
      }
    });

    this.addCommand({
      id: "renumber-figures",
      name: "Renumber all figures",
      editorCallback: (editor) => {
        const count = renumberAllFigures(editor);
        new Notice(
          count
            ? `Renumbered ${count} figure${count === 1 ? "" : "s"}`
            : "No figures found to renumber"
        );
      }
    });

    this.registerEvent(
      this.app.workspace.on("editor-drop", (evt, editor, info) =>
        this.handleImageInsertEvent(evt, editor, info, "drop")
      )
    );
    this.registerEvent(
      this.app.workspace.on("editor-paste", (evt, editor, info) =>
        this.handleImageInsertEvent(evt, editor, info, "paste")
      )
    );

    // Markdown postprocessor — default figures get a canonical DOM so Reading
    // view can place the caption in the margin. Live Preview keeps the same
    // DOM but CSS hides the injected label there because the editable callout
    // title already shows "Fig. N.".
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      if (!this.syncEnabledClass()) return;
      for (const callout of matchingElements(el, '.callout[data-callout="figure"]')) {
        await decorateDefaultFigure(callout, ctx, this.app, this, el);
      }
      for (const callout of matchingElements(el, '.callout[data-callout="figure-full"]')) {
        await decorateFullFigure(callout, ctx, this.app, this, el);
      }
      for (const callout of matchingElements(el, '.callout[data-callout="figure-margin"]')) {
        await decorateMarginFigure(callout, ctx, this.app, this, el);
      }
      matchingElements(el, '.callout[data-callout="marginnote"]').forEach(decorateLegacyMarginFigure);
      hideOrphanFigureAnchors(el);
    });

    // Click a figure image in Reading view to enlarge it (lightbox).
    this.registerDomEvent(
      document,
      "click",
      (evt) => this.handleFigureImageClick(evt),
      { capture: true }
    );

    // Snapshot any image being dragged from inside Obsidian (file explorer,
    // search, etc.) the moment the drag starts. The drag manager is sometimes
    // cleared before `editor-drop` fires, so this snapshot is the reliable
    // source for opening the modal on an internally-dragged image.
    this._lastDraggedImages = [];
    this._lastDragStartedAt = 0;
    this.registerDomEvent(document, "dragstart", (e) => {
      this._lastDraggedImages = this.imagesFromDragSource(e);
      this._lastDragStartedAt = Date.now();
    });
    this.registerDomEvent(document, "dragend", () => {
      this._lastDraggedImages = [];
    });

    // Obsidian ≥1.6 (verified against 1.13.4's app.js): when a drag begins
    // INSIDE the app, the editor's drop handler sees app.dragManager.draggable
    // and inserts a plain link directly — `editor-drop` is only triggered on
    // its external-drag branch, so handleImageInsertEvent never runs for a
    // drag from the file explorer. Catch the DOM drop first, in the capture
    // phase, and open the figure modal from there.
    this.registerDomEvent(
      document,
      "drop",
      (e) => this.handleInternalDropCapture(e),
      { capture: true }
    );
  }

  // Capture-phase companion to handleImageInsertEvent, for image drags that
  // start inside the vault (file explorer, search, bookmarks) and would
  // otherwise be consumed by Obsidian's own drop handling before
  // `editor-drop` ever fires.
  handleInternalDropCapture(evt) {
    if (!evt || evt.defaultPrevented) return;
    if (!this.settings.interceptDrops) return;
    // A held modifier asks Obsidian for one of its alternate drop behaviors
    // (copy path, drop-into-pane…) — stay out of the way.
    if (evt.shiftKey || evt.altKey || evt.ctrlKey || evt.metaKey) return;
    const target = evt.target;
    if (!(target instanceof Element)) return;
    // Only editable Markdown panes. Reading view and the modal's own drop
    // zones keep their existing handling.
    const paneEl = target.closest(".markdown-source-view.mod-cm6");
    if (!paneEl) return;
    // Only drags that started inside the vault and carry an image file;
    // external OS drags leave both sources empty and fall through to the
    // `editor-drop` path.
    const tfile =
      draggedImageFiles(this.app)[0] || this.snapshotImage() || null;
    if (!tfile) return;
    if (!this.syncEnabledClass()) return;
    const view = this.markdownViewAround(paneEl);
    const editor = view && view.editor;
    if (!editor) return;
    evt.preventDefault();
    evt.stopPropagation();
    // Consume the snapshot so a missed `dragend` can't leave it around to
    // hijack a later, unrelated drop.
    this._lastDraggedImages = [];
    const pos = posFromMouse(editor, evt) || editor.getCursor();
    const sourcePath =
      (view.file && view.file.path) ||
      this.app.workspace.getActiveFile()?.path ||
      "";
    const embed = this.buildEmbed(tfile, sourcePath);
    // Insertions never seed alt text: a `|alt` display segment on the embed
    // renders as a grey caption box under the figure, so alt stays opt-in
    // via the modal's Alt field. Same rule on every insertion path below.
    new FigureModal(this.app, this, editor, {
      embed,
      altDefault: "",
      pos,
      sourcePath
    }).open();
  }

  // The dragstart snapshot, guarded by age: if a `dragend` was ever missed
  // (window teardown mid-drag), a stale snapshot must not claim a later,
  // unrelated drop. Any real drag's drop lands well within the window.
  snapshotImage() {
    if (!this._lastDraggedImages || !this._lastDraggedImages.length) return null;
    if (Date.now() - (this._lastDragStartedAt || 0) > 30000) return null;
    return this._lastDraggedImages[0];
  }

  // The markdown view whose DOM contains `el` — the drop may land on a pane
  // that isn't the active one.
  markdownViewAround(el) {
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf && leaf.view;
      if (
        !found &&
        view &&
        typeof view.getViewType === "function" &&
        view.getViewType() === "markdown" &&
        view.containerEl &&
        view.containerEl.contains(el)
      ) {
        found = view;
      }
    });
    return found;
  }

  // Resolve the image TFile(s) at the source of a drag: first the Obsidian
  // drag manager, then a `data-path` attribute on the dragged element (file
  // explorer / search rows carry one), so we don't depend solely on internals.
  imagesFromDragSource(e) {
    const fromManager = draggedImageFiles(this.app);
    if (fromManager.length) return fromManager;
    const el = e.target && e.target.closest ? e.target.closest("[data-path]") : null;
    if (el) {
      const p = el.getAttribute("data-path");
      const f = p ? this.app.vault.getAbstractFileByPath(p) : null;
      if (isImageTFile(f)) return [f];
    }
    return [];
  }

  handleFigureImageClick(evt) {
    if (!this.syncEnabledClass()) return;
    const target = evt.target;
    if (!(target instanceof HTMLImageElement)) return;
    if (!target.closest(".markdown-preview-view")) return;
    if (
      !target.closest(
        '.callout[data-callout="figure"], .callout[data-callout="figure-full"], .callout[data-callout="figure-margin"], .callout[data-callout="marginnote"]'
      )
    ) {
      return;
    }
    evt.preventDefault();
    evt.stopPropagation();
    this.openLightbox(target.currentSrc || target.src, target.alt || "");
  }

  openLightbox(src, alt) {
    if (!src) return;
    const overlay = document.createElement("div");
    overlay.className = "tufte-fig-lightbox";
    const img = document.createElement("img");
    img.src = src;
    if (alt) img.alt = alt;
    overlay.appendChild(img);

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    overlay.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  syncEnabledClass() {
    const enabled = this.isTufteThemeActive();
    document.body?.classList.toggle(ENABLED_CLASS, enabled);
    document.documentElement?.classList.toggle(ENABLED_CLASS, enabled);
    return enabled;
  }

  isTufteThemeActive() {
    // Desktop: vault config exposes the active CSS theme name.
    try {
      if (this.app.vault.getConfig?.("cssTheme") === "Tufte") return true;
    } catch {}
    // Mobile / fallback: probe for a CSS variable the theme defines.
    try {
      const targets = [
        document.body,
        document.documentElement,
        document.querySelector(".workspace-leaf.mod-active") ||
          document.querySelector(".markdown-source-view, .markdown-preview-view")
      ].filter(Boolean);
      for (const target of targets) {
        const probe = getComputedStyle(target)
          .getPropertyValue("--tufte-accent")
          .trim();
        if (probe.length > 0) return true;
      }
    } catch {}
    return false;
  }

  handleImageInsertEvent(evt, editor, info, kind) {
    if (!evt || evt.defaultPrevented) return;
    if (!this.settings.interceptDrops) return;
    if (!this.syncEnabledClass()) return;

    const dt = kind === "drop" ? evt.dataTransfer : evt.clipboardData;
    const file = firstImageFile(dt);

    let pos = editor.getCursor();
    if (kind === "drop") {
      const dropPos = posFromMouse(editor, evt);
      if (dropPos) pos = dropPos;
    }

    if (file) {
      evt.preventDefault();
      this.saveAndOpenModal(file, editor, info, pos);
      return;
    }

    // Internal vault image (dragged from the file explorer or as a link):
    // there's no external File, but Obsidian's drag manager — or the dropped
    // text — points at an existing image TFile. Open the modal on it directly.
    if (kind === "drop") {
      const tfile = this.internalImageFromDrop(evt, info);
      if (tfile) {
        evt.preventDefault();
        const sourcePath =
          info?.file?.path || this.app.workspace.getActiveFile()?.path || "";
        const embed = this.buildEmbed(tfile, sourcePath);
        new FigureModal(this.app, this, editor, {
          embed,
          altDefault: "",
          pos,
          sourcePath
        }).open();
      }
    }
  }

  internalImageFromDrop(evt, info) {
    const fromManager = draggedImageFiles(this.app);
    if (fromManager.length) return fromManager[0];

    // Snapshot captured at dragstart — survives the drag manager being cleared
    // before this drop event fires (the common file-explorer case).
    const snap = this.snapshotImage();
    if (snap) return snap;

    let text = "";
    try {
      text = evt.dataTransfer?.getData("text/plain") || "";
    } catch {}
    const linkpath = linkpathFromDropText(text);
    if (!linkpath) return null;
    const sourcePath =
      info?.file?.path || this.app.workspace.getActiveFile()?.path || "";
    const f = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    return isImageTFile(f) ? f : null;
  }

  async saveAndOpenModal(file, editor, info, pos) {
    const sourcePath =
      info?.file?.path || this.app.workspace.getActiveFile()?.path || "";

    let embed = "";
    try {
      const ext = extFromType(file.type) || fileExt(file.name) || "png";
      const baseName =
        file.name && file.name.toLowerCase() !== "image.png"
          ? file.name
          : `pasted-image-${Date.now()}.${ext}`;
      const path = await this.app.fileManager.getAvailablePathForAttachment(
        baseName,
        sourcePath
      );
      const buffer = await file.arrayBuffer();
      const tfile = await this.app.vault.createBinary(path, buffer);
      embed = this.buildEmbed(tfile, sourcePath);
    } catch (e) {
      console.error("tufte-figures: failed to save dropped image", e);
      new Notice("Tufte Figures: couldn't save the image.");
      return;
    }

    new FigureModal(this.app, this, editor, { embed, altDefault: "", pos, sourcePath }).open();
  }

  buildEmbed(tfile, sourcePath) {
    let link = "";
    try {
      link = this.app.fileManager.generateMarkdownLink(tfile, sourcePath) || "";
    } catch {}
    if (!link) link = `![[${tfile.path}]]`;
    if (!link.startsWith("!")) link = "!" + link;
    return link;
  }

};

// --- image-event helpers -------------------------------------------------

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
  "heic",
  "heif"
]);

function isImageTFile(file) {
  return !!(file && file.extension && IMAGE_EXTS.has(file.extension.toLowerCase()));
}

// Image TFiles currently being dragged from inside Obsidian (file explorer,
// search results, etc.), via the app drag manager.
function draggedImageFiles(app) {
  try {
    const d = app.dragManager && app.dragManager.draggable;
    if (!d) return [];
    if (Array.isArray(d.files)) return d.files.filter(isImageTFile);
    if (d.file && isImageTFile(d.file)) return [d.file];
  } catch {}
  return [];
}

// Best-effort linkpath from the text a drop carries — a wiki embed/link,
// a markdown link target, or a bare image path.
function linkpathFromDropText(text) {
  if (!text) return "";
  const wiki = text.match(/\[\[([^\]|#]+)/);
  if (wiki) return wiki[1].trim();
  const md = text.match(/\]\(([^)\s]+)/);
  if (md) {
    try {
      return decodeURIComponent(md[1].trim());
    } catch {
      return md[1].trim();
    }
  }
  const trimmed = text.trim();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)$/i.test(trimmed)) return trimmed;
  return "";
}

function firstImageFile(dt) {
  if (!dt) return null;
  const files = dt.files;
  if (files && files.length) {
    for (const f of files) {
      if (f && typeof f.type === "string" && f.type.startsWith("image/")) {
        return f;
      }
    }
  }
  const items = dt.items;
  if (items && items.length) {
    for (const it of items) {
      if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) return f;
      }
    }
  }
  return null;
}

function posFromMouse(editor, evt) {
  try {
    const cm = editor.cm;
    if (cm && typeof cm.posAtCoords === "function") {
      const offset = cm.posAtCoords({ x: evt.clientX, y: evt.clientY });
      if (offset != null && typeof editor.offsetToPos === "function") {
        return editor.offsetToPos(offset);
      }
    }
  } catch {}
  return null;
}

function extFromType(type) {
  if (!type) return "";
  const map = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/avif": "avif",
    "image/heic": "heic"
  };
  return map[type.toLowerCase()] || "";
}

function fileExt(name) {
  if (!name || name.indexOf(".") === -1) return "";
  return name.split(".").pop();
}

// --- embed parsing / sizing ----------------------------------------------

// A trailing pipe segment of `WIDTH` or `WIDTHxHEIGHT` is Obsidian's native
// image size; an earlier segment is alt/display text.
const EMBED_SIZE_RE = /^(\d+)(?:x(\d+))?$/;

// Split an image embed into its parts. Recognises wiki embeds
// (`![[path|alt|WxH]]`, any of alt/size optional) and markdown embeds
// (`![alt|WxH](url)`). `kind: "other"` means an embed we can't resize.
function parseEmbed(embed) {
  const raw = (embed || "").trim();

  const wiki = raw.match(/^!\[\[([^\]]+)\]\]$/);
  if (wiki) {
    const segs = wiki[1].split("|");
    const path = segs.shift();
    let width, height, alt;
    if (segs.length) {
      const size = segs[segs.length - 1].trim().match(EMBED_SIZE_RE);
      if (size) {
        width = size[1];
        height = size[2];
        segs.pop();
      }
    }
    if (segs.length) alt = segs.join("|");
    return { kind: "wiki", path, alt, width, height, raw };
  }

  const md = raw.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (md) {
    const segs = (md[1] || "").split("|");
    let width, height;
    if (segs.length > 1) {
      const size = segs[segs.length - 1].trim().match(EMBED_SIZE_RE);
      if (size) {
        width = size[1];
        height = size[2];
        segs.pop();
      }
    }
    return { kind: "md", path: md[2], alt: segs.join("|"), width, height, raw };
  }

  return { kind: "other", path: "", alt: "", width: undefined, height: undefined, raw };
}

// Rebuild an embed string from parts, emitting Obsidian's native size token.
// `W` when only a width is set (height stays auto, preserving the ratio);
// `WxH` when an explicit independent height is set.
function composeEmbed(parts) {
  const { kind, path, raw } = parts;
  const alt = (parts.alt || "").trim();
  const width = parts.width != null ? String(parts.width).trim() : "";
  const height = parts.height != null ? String(parts.height).trim() : "";
  const size = width ? (height ? `${width}x${height}` : width) : "";

  if (kind === "wiki") {
    const segs = [path];
    if (alt) segs.push(alt);
    if (size) segs.push(size);
    return `![[${segs.join("|")}]]`;
  }

  if (kind === "md") {
    const altField = size ? `${alt}|${size}` : alt;
    return `![${altField}](${path})`;
  }

  return raw;
}

function embedHasSize(markdown) {
  return parseEmbed(markdown).width != null;
}

// --- image-quilt helpers -------------------------------------------------

function mimeFromExt(ext) {
  const e = (ext || "").toLowerCase();
  const map = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    avif: "image/avif",
    heic: "image/heic",
    heif: "image/heif"
  };
  return map[e] || "image/png";
}

// Vault-adapter writeBinary wants an ArrayBuffer; normalise a Uint8Array view.
function toArrayBuffer(u8) {
  if (u8 instanceof ArrayBuffer) return u8;
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer;
  return u8.slice().buffer;
}

// The hidden per-quilt folder under the vault config dir (e.g. `.obsidian`),
// so it never shows in the file explorer.
function quiltDir(app, id) {
  return `${app.vault.configDir}/plugins/tufte-figures/quilts/${id}`;
}

// Normalise the user's quilt-output folder setting to a clean vault-relative
// path (no leading/trailing slashes); empty means the vault root.
function normalizeQuiltFolder(s) {
  return String(s || "").trim().replace(/^\/+|\/+$/g, "");
}

// Create a folder and every missing parent, ignoring "already exists".
async function ensureFolder(adapter, path) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    try {
      if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
    } catch {}
  }
}

// A figure that embeds `quilt-<id>.png` is a generated quilt; pull the id back
// out so its config sidecar can be located for re-editing.
function quiltIdFromEmbed(embed) {
  const parsed = parseEmbed(embed);
  const path = (parsed.path || "").split("#")[0];
  const m = path.match(/quilt-(\d+)(?:[ _-]\d+)?\.png$/i);
  return m ? m[1] : null;
}

// Pure layout: uniform-height tiles packed edge-to-edge left-to-right, wrapping
// when the next tile would exceed maxWidth. Ragged right edge (transparent in
// the export). Returns total {width,height} and per-tile {x,y,w,h} placements.
function layoutQuilt(tiles, rowHeight, maxWidth) {
  const limit = Math.max(rowHeight, maxWidth || 480);
  const placements = [];
  let x = 0;
  let y = 0;
  let widest = 0;
  for (const tile of tiles) {
    const w = Math.max(1, Math.round(rowHeight * (tile.ratio || 1)));
    if (x > 0 && x + w > limit) {
      y += rowHeight;
      x = 0;
    }
    placements.push({ tile, x, y, w, h: rowHeight });
    x += w;
    if (x > widest) widest = x;
  }
  return {
    width: widest,
    height: placements.length ? y + rowHeight : 0,
    placements
  };
}

// --- markdown builders ---------------------------------------------------

function buildFigureBlock(mode, fields) {
  const { embed, caption, number, labelPrefix } = fields;
  const num = number || "1";
  const parsed = parseEmbed(embed);
  const alt = fields.alt != null ? fields.alt.trim() : parsed.alt;
  const width = fields.width != null ? fields.width : parsed.width;
  const height = fields.height != null ? fields.height : parsed.height;
  const finalEmbed = composeEmbed({ ...parsed, alt, width, height });
  const anchor = `\n\n^fig-${num}`;
  const label = `${labelPrefix || "Fig."} ${num}.`;

  const calloutType =
    mode === "full" ? "figure-full" : mode === "margin" ? "figure-margin" : "figure";
  const cap = caption ? `\n> ${caption}` : "";
  // Callout title is the rendered figure label ("Fig. N.") — same text
  // both in the editor and in reading view.
  return `> [!${calloutType}] ${label}\n> ${finalEmbed}${cap}${anchor}`;
}

// A row of images in one callout (≥2 images). Each entry line is
// `> <embed> (label) caption`; a trailing non-image line is the overall
// caption. Per-image width is precomputed from the shared row height so the
// images render at equal heights with their ratios preserved.
function buildMultiFigureBlock(mode, fields) {
  const { entries, overallCaption, number, labelPrefix } = fields;
  const num = number || "1";
  const label = `${labelPrefix || "Fig."} ${num}.`;
  const calloutType =
    mode === "full" ? "figure-full" : mode === "margin" ? "figure-margin" : "figure";

  const lines = [`> [!${calloutType}] ${label}`];
  for (const entry of entries) {
    const parsed = parseEmbed(entry.embed);
    const width = entry.width != null && entry.width !== "" ? entry.width : parsed.width;
    const embed = composeEmbed({ ...parsed, width, height: "" });
    const lbl = entry.label ? ` (${entry.label})` : "";
    const cap = entry.caption ? ` ${entry.caption}` : "";
    lines.push(`> ${embed}${lbl}${cap}`);
  }
  if (overallCaption && overallCaption.trim()) {
    lines.push(`> ${overallCaption.trim()}`);
  }
  return `${lines.join("\n")}\n\n^fig-${num}`;
}

function insertBlockAtPos(editor, block, pos) {
  const target = pos || editor.getCursor();
  const lineText = editor.getLine(target.line) || "";
  const beforeCursor = lineText.slice(0, target.ch);
  const atCleanLineStart = /^\s*$/.test(beforeCursor);
  const prefix = atCleanLineStart ? "" : "\n";
  editor.replaceRange(`${prefix}${block}\n`, target);
  editor.focus?.();
}

const EDITABLE_FIGURE_TYPES = new Set(["figure", "figure-full", "figure-margin"]);

// Locate the figure block enclosing the cursor (the cursor may sit on a
// blockquote line, the trailing `^fig-N` anchor, or a blank line between
// them). Returns the inclusive line range and its lines, or null.
function findFigureAtCursor(editor) {
  const total = editor.lineCount();
  const cur = editor.getCursor().line;
  const isQuote = (i) => i >= 0 && i < total && /^\s*>/.test(editor.getLine(i) || "");
  const isBlank = (i) => /^\s*$/.test(editor.getLine(i) || "");

  let calloutLine = -1;
  if (isQuote(cur)) {
    calloutLine = cur;
  } else {
    let i = cur;
    while (i >= 0 && (isBlank(i) || ANCHOR_LINE_RE.test(editor.getLine(i) || ""))) i--;
    if (isQuote(i)) calloutLine = i;
  }
  if (calloutLine < 0) return null;

  let start = calloutLine;
  while (start > 0 && isQuote(start - 1)) start--;
  let end = calloutLine;
  while (end < total - 1 && isQuote(end + 1)) end++;

  const header = (editor.getLine(start) || "").match(CALLOUT_HEADER_RE);
  if (!header) return null;
  const type = (header[2] || "").toLowerCase();
  if (!EDITABLE_FIGURE_TYPES.has(type)) return null;

  let blockEnd = end;
  let j = end + 1;
  while (j < total && isBlank(j)) j++;
  if (j < total && ANCHOR_LINE_RE.test(editor.getLine(j) || "")) blockEnd = j;

  const lines = [];
  for (let k = start; k <= blockEnd; k++) lines.push(editor.getLine(k) || "");
  return { start, end: blockEnd, type, lines };
}

// Parse a figure block's lines into modal-ready state: mode, number, the
// image entries (embed + optional label/caption) and the overall caption.
function parseFigureBlock(lines) {
  let type = "figure";
  let number = "";
  let started = false;
  const images = [];
  const textLines = [];

  for (const line of lines) {
    const header = line.match(CALLOUT_HEADER_RE);
    if (header && !started) {
      type = (header[2] || "").toLowerCase();
      const title = (header[3] || "").trim();
      const nm = title.match(/(\d+)/);
      if (nm) number = nm[1];
      started = true;
      continue;
    }
    if (!started) continue;
    const anchor = line.match(ANCHOR_LINE_RE);
    if (anchor) {
      number = anchor[1];
      break;
    }
    const quote = line.match(BLOCKQUOTE_LINE_RE);
    if (!quote) continue;
    const body = (quote[1] || "").trim();
    if (!body) continue;
    const lead = body.match(IMAGE_LEAD_RE);
    if (lead) {
      let label = "";
      let caption = (lead[2] || "").trim();
      const labelled = caption.match(ENTRY_LABEL_RE);
      if (labelled) {
        label = labelled[1].trim();
        caption = (labelled[2] || "").trim();
      }
      caption = caption.replace(CAPTION_MARKER_RE, "").trim();
      images.push({ embed: lead[1], label, caption });
    } else {
      textLines.push(body.replace(CAPTION_MARKER_RE, ""));
    }
  }

  const mode =
    type === "figure-full" ? "full" : type === "figure-margin" ? "margin" : "default";
  return { mode, number, images, overall: textLines.join("\n").trim() };
}

// --- numbering -----------------------------------------------------------

function nextFigureNumber(source) {
  const re = /\^fig-(\d+)\b/g;
  let max = 0;
  let m;
  while ((m = re.exec(source))) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function figureAnchorNumbers(source) {
  const nums = [];
  const seen = new Set();
  const re = /^\s*\^fig-(\d+)\s*$/gm;
  let m;
  while ((m = re.exec(source))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    nums.push(m[1]);
  }
  return nums;
}

function selectedOrNearbyFigureNumber(editor) {
  try {
    const selection = editor.getSelection?.() || "";
    const selected = selection.match(/\b(?:fig\.?|figure|\^fig-)?\s*(\d+)\b/i);
    if (selected) return selected[1];
  } catch {}

  try {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line) || "";
    const before = line.slice(0, cursor.ch);
    const after = line.slice(cursor.ch);
    const nearby = `${before.slice(-40)}${after.slice(0, 40)}`;
    const match =
      nearby.match(/\^fig-(\d+)\b/i) ||
      nearby.match(/\b(?:fig\.?|figure)\s+(\d+)\b/i);
    if (match) return match[1];
  } catch {}

  return "";
}

function defaultFigureReferenceNumber(editor) {
  const nearby = selectedOrNearbyFigureNumber(editor);
  if (nearby) return nearby;
  const nums = figureAnchorNumbers(editor.getValue());
  return nums.length ? nums[nums.length - 1] : "1";
}

function figureReferenceText(number) {
  const n = String(number || "N").trim() || "N";
  return `[[#^fig-${n}|(Fig. ${n})]]`;
}

function insertInlineText(editor, text) {
  if (typeof editor.replaceSelection === "function") {
    editor.replaceSelection(text);
    return;
  }
  editor.replaceRange(text, editor.getCursor());
}

function renumberAllFigures(editor) {
  const lines = editor.getValue().split("\n");

  // 1. Locate figure units: a figure/figure-full/figure-margin/marginnote
  //    callout whose block is immediately followed (after optional blank
  //    lines) by a `^fig-OLD` anchor line.
  const units = [];
  for (let i = 0; i < lines.length; i++) {
    const anchorMatch = lines[i].match(ANCHOR_LINE_RE);
    if (!anchorMatch) continue;

    // Walk back over blank lines to the preceding block's last line.
    let j = i - 1;
    while (j >= 0 && /^\s*$/.test(lines[j])) j--;
    if (j < 0) continue;

    // The preceding block must be a blockquote (callout). Walk up to its top.
    if (!/^\s*>/.test(lines[j])) continue;
    let k = j;
    while (k >= 0 && /^\s*>/.test(lines[k])) k--;
    const calloutStart = k + 1;

    const header = lines[calloutStart].match(CALLOUT_HEADER_RE);
    if (!header) continue;
    const type = header[2].toLowerCase();
    if (!FIGURE_CALLOUT_TYPES.has(type)) continue;

    units.push({
      old: anchorMatch[1],
      anchorLine: i,
      type,
      calloutStart,
      calloutEnd: j
    });
  }

  if (!units.length) return 0;

  // 2. Sequential numbering in document order.
  const map = new Map();
  units.forEach((u, idx) => map.set(u.old, String(idx + 1)));

  // 3. Per-unit rewrites: anchor line, callout title (modes 1, 2, and new
  //    margin figures — supports legacy bare-number "1" and "Fig. 1.")
  //    or the literal "Fig. N." in legacy marginnote captions.
  for (const u of units) {
    const neu = map.get(u.old);

    lines[u.anchorLine] = lines[u.anchorLine].replace(
      /\^fig-\d+/,
      `^fig-${neu}`
    );

    if (
      u.type === "figure" ||
      u.type === "figure-full" ||
      u.type === "figure-margin"
    ) {
      lines[u.calloutStart] = lines[u.calloutStart].replace(
        /^(\s*>\s*\[![a-z-]+\][+-]?\s+)(.*)$/i,
        (full, head, tail) => {
          const t = tail.trim();
          if (/^(Fig\.?|Figure)\s+\d+\.?$/i.test(t)) {
            // "Fig. 5" / "Fig. 5." / "Figure 5" — rewrite to "Fig. NEW."
            return `${head}Fig. ${neu}.`;
          }
          if (/^\d+$/.test(t)) {
            // Legacy bare-number title — upgrade to "Fig. NEW."
            return `${head}Fig. ${neu}.`;
          }
          // Unrecognized title form — replace any digit run after Fig./Figure
          // if present, else leave untouched.
          const tNew = t.replace(/(Fig\.?|Figure)\s+\d+(\.?)/i, (m, p, dot) => `${p} ${neu}${dot || "."}`);
          return `${head}${tNew}`;
        }
      );
    } else {
      const oldNumRe = new RegExp(`(Figure|Fig\\.?)\\s+${u.old}\\b`, "g");
      for (let li = u.calloutStart; li <= u.calloutEnd; li++) {
        lines[li] = lines[li].replace(oldNumRe, (mm, label) => `${label} ${neu}`);
      }
    }
  }

  // 4. Rewrite every reference `[[#^fig-OLD|…]]` / `[[#^fig-OLD]]` using the
  //    map to the canonical `[[#^fig-NEW|(Fig. NEW)]]` form. A single
  //    left-to-right pass reads OLD from the match, so there is no chained
  //    re-mapping even though OLD and NEW number spaces overlap. Legacy
  //    aliases (bare number) are upgraded in the process.
  let body = lines.join("\n");
  body = body.replace(/\[\[#\^fig-(\d+)(?:\|[^\]]*)?\]\]/g, (full, old) => {
    const neu = map.get(old);
    return neu ? `[[#^fig-${neu}|(Fig. ${neu})]]` : full;
  });

  const cursor = editor.getCursor();
  editor.setValue(body);
  try {
    const lineCount = editor.lineCount();
    editor.setCursor({ line: Math.min(cursor.line, lineCount - 1), ch: 0 });
  } catch {}

  return units.length;
}

// --- DOM decoration ------------------------------------------------------
//
// The postprocessor runs in both reading view and the editor's live-preview
// embedded callouts. Each helper is idempotent: it marks the callout with
// `data-tufte-figure-decorated="1"` so subsequent passes are no-ops.
//
// `findFigureParas` returns the rendered image-bearing paragraph and caption
// paragraph inside a callout content element. It tolerates the `<p>` ->
// `<.el-p>` -> `<p>` wrappers Obsidian sometimes emits inside callouts; an
// explicit `[!caption]` marker wins, with legacy non-image paragraphs as a
// fallback.

function matchingElements(root, selector) {
  const matches = [];
  if (root.matches?.(selector)) matches.push(root);
  root.querySelectorAll?.(selector).forEach((el) => matches.push(el));
  return matches;
}

function innerParaForHolder(holder) {
  if (!holder) return null;
  if (holder.tagName === "P") return holder;
  return (
    holder.querySelector(":scope > p") ||
    holder.querySelector(":scope > .el-p > p") ||
    holder
  );
}

function holderHasImage(holder) {
  return (
    holder.matches?.(".internal-embed, .image-embed, img") ||
    holder.querySelector(".internal-embed, .image-embed, img") != null
  );
}

function holderHasCaptionMarker(holder) {
  return CAPTION_MARKER_RE.test(holder.textContent || "");
}

function stripCaptionMarker(holder) {
  const match = (holder.textContent || "").match(CAPTION_MARKER_RE);
  if (!match) return false;

  let remaining = match[0].length;
  const walker = (holder.ownerDocument || document).createTreeWalker(
    holder,
    NodeFilter.SHOW_TEXT,
    null
  );
  let node;
  while (remaining > 0 && (node = walker.nextNode())) {
    if (!node.nodeValue) continue;
    const cut = Math.min(remaining, node.nodeValue.length);
    node.nodeValue = node.nodeValue.slice(cut);
    remaining -= cut;
  }
  return true;
}

function findFigureParas(content) {
  const direct = Array.from(content.children);
  const imageHolders = [];
  const explicitCaptionHolders = [];
  const captionHolders = [];
  for (const child of direct) {
    if (child.tagName !== "P" && !child.classList?.contains("el-p")) continue;
    const hasCaptionMarker = holderHasCaptionMarker(child);
    const hasImage = holderHasImage(child);
    if (hasCaptionMarker) explicitCaptionHolders.push(child);
    if (hasImage) imageHolders.push(child);
    else if (!hasCaptionMarker) captionHolders.push(child);
  }
  const captions = explicitCaptionHolders.length
    ? explicitCaptionHolders
    : captionHolders;
  const captionHolder = captions[0] || null;
  const captionPara = innerParaForHolder(captionHolder);
  const imageHolder = imageHolders[0] || null;
  const imagePara = innerParaForHolder(imageHolder);
  if (explicitCaptionHolders.length && captionPara) {
    stripCaptionMarker(captionPara);
  }
  return { imageHolder, captionHolder, captionPara, imagePara };
}

function directFigureBlocks(content) {
  return Array.from(content.children).filter((child) => {
    if (
      child.classList?.contains("tufte-fig-image-holder") ||
      child.classList?.contains("tufte-fig-caption-holder")
    ) {
      return false;
    }
    return (
      child.tagName === "P" ||
      child.classList?.contains("el-p") ||
      holderHasImage(child) ||
      (child.textContent || "").trim().length > 0
    );
  });
}

function findDefaultFigureParts(content) {
  const blocks = directFigureBlocks(content);
  const explicitCaptionBlock =
    blocks.find((block) => holderHasCaptionMarker(block)) || null;
  const imageBlock =
    blocks.find((block) => holderHasImage(block)) ||
    blocks.find((block) => block !== explicitCaptionBlock) ||
    null;

  let captionBlock = explicitCaptionBlock;
  if (!captionBlock) {
    const imageIndex = imageBlock ? blocks.indexOf(imageBlock) : -1;
    captionBlock =
      blocks.find((block, idx) => {
        if (block === imageBlock) return false;
        if (holderHasImage(block)) return false;
        if (imageIndex >= 0 && idx < imageIndex) return false;
        return (block.textContent || "").trim().length > 0;
      }) || null;
  }

  if (!captionBlock) {
    captionBlock =
      blocks.find((block) => block !== imageBlock && !holderHasImage(block)) ||
      null;
  }

  if (captionBlock) stripCaptionMarker(captionBlock);

  return { imageBlock, captionBlock };
}

function getSectionInfo(ctx, el, fallbackEl) {
  try {
    return (
      ctx?.getSectionInfo?.(el) ||
      (fallbackEl && fallbackEl !== el ? ctx?.getSectionInfo?.(fallbackEl) : null) ||
      null
    );
  } catch {
    return null;
  }
}

function extractFigureMarkdown(ctx, callout, fallbackEl, calloutType) {
  const sectionInfo = getSectionInfo(ctx, callout, fallbackEl);
  const source = sectionInfo?.text || "";
  if (!source) return { imageMarkdown: "", captionMarkdown: "" };

  // Scope parsing to THIS callout's lines. `getSectionInfo` returns the whole
  // file text plus the rendered element's line range; without slicing we'd
  // always match the first callout of this type in the file, so every
  // same-mode figure would render the first figure's image and caption.
  const allLines = source.split(/\r?\n/);
  const start = Number.isInteger(sectionInfo.lineStart) ? sectionInfo.lineStart : 0;
  const end = Number.isInteger(sectionInfo.lineEnd)
    ? sectionInfo.lineEnd
    : allLines.length - 1;
  const lines = allLines.slice(start, end + 1);
  let inFigure = false;
  let sawImage = false;
  let collectingCaption = false;
  let imageMarkdown = "";
  const captionLines = [];

  for (const line of lines) {
    const header = line.match(CALLOUT_HEADER_RE);
    if (header) {
      const type = (header[2] || "").toLowerCase();
      if (!inFigure && type === calloutType) {
        inFigure = true;
        continue;
      }
      if (inFigure && collectingCaption) break;
    }

    if (!inFigure) continue;
    if (ANCHOR_LINE_RE.test(line)) break;

    const quote = line.match(BLOCKQUOTE_LINE_RE);
    if (!quote) {
      if (collectingCaption) break;
      continue;
    }

    let body = quote[1] || "";
    if (!sawImage) {
      if (IMAGE_MARKDOWN_RE.test(body.trim())) {
        imageMarkdown = body.trim();
        sawImage = true;
      }
      continue;
    }

    if (ANCHOR_LINE_RE.test(body)) break;
    if (!collectingCaption && !body.trim()) continue;
    if (!collectingCaption && IMAGE_MARKDOWN_RE.test(body.trim())) continue;

    body = body.replace(CAPTION_MARKER_RE, "");
    if (!collectingCaption && !body.trim()) continue;
    collectingCaption = true;
    captionLines.push(body);
  }

  return {
    imageMarkdown,
    captionMarkdown: captionLines.join("\n").trim()
  };
}

function extractDefaultFigureMarkdown(ctx, callout, fallbackEl) {
  return extractFigureMarkdown(ctx, callout, fallbackEl, "figure");
}

function extractFullFigureMarkdown(ctx, callout, fallbackEl) {
  return extractFigureMarkdown(ctx, callout, fallbackEl, "figure-full");
}

function extractMarginFigureMarkdown(ctx, callout, fallbackEl) {
  return extractFigureMarkdown(ctx, callout, fallbackEl, "figure-margin");
}

// Parse a figure callout as a multi-image row. Returns every image entry
// (with its `(label)` and individual caption) plus the trailing overall
// caption. `isMulti` is true only when 2+ images are present, so single
// figures fall through to the existing single-image decoration path.
function extractMultiFigure(ctx, callout, fallbackEl, calloutType) {
  const sectionInfo = getSectionInfo(ctx, callout, fallbackEl);
  const source = sectionInfo?.text || "";
  if (!source) return { entries: [], overallCaption: "", isMulti: false };

  const allLines = source.split(/\r?\n/);
  const start = Number.isInteger(sectionInfo.lineStart) ? sectionInfo.lineStart : 0;
  const end = Number.isInteger(sectionInfo.lineEnd)
    ? sectionInfo.lineEnd
    : allLines.length - 1;
  const lines = allLines.slice(start, end + 1);

  let inFigure = false;
  const entries = [];
  const overallLines = [];
  for (const line of lines) {
    const header = line.match(CALLOUT_HEADER_RE);
    if (header) {
      const type = (header[2] || "").toLowerCase();
      if (!inFigure && type === calloutType) {
        inFigure = true;
        continue;
      }
      if (inFigure) break; // a different callout begins — stop
    }
    if (!inFigure) continue;
    if (ANCHOR_LINE_RE.test(line)) break;

    const quote = line.match(BLOCKQUOTE_LINE_RE);
    if (!quote) continue;
    const body = (quote[1] || "").trim();
    if (!body || ANCHOR_LINE_RE.test(body)) continue;

    const lead = body.match(IMAGE_LEAD_RE);
    if (lead) {
      const imageMarkdown = lead[1];
      let label = "";
      let caption = (lead[2] || "").trim();
      const labelled = caption.match(ENTRY_LABEL_RE);
      if (labelled) {
        label = labelled[1].trim();
        caption = (labelled[2] || "").trim();
      }
      caption = caption.replace(CAPTION_MARKER_RE, "").trim();
      entries.push({ imageMarkdown, label, caption });
    } else {
      overallLines.push(body.replace(CAPTION_MARKER_RE, ""));
    }
  }

  return {
    entries,
    overallCaption: overallLines.join("\n").trim(),
    isMulti: entries.length >= 2
  };
}

// Rebuild the figure's source-style lines from already-rendered DOM. Obsidian
// merges the consecutive blockquote lines of a callout into a single <p> with
// <br> separators, so we split on <br> and block boundaries to recover one
// string per original line. Image embeds become `![[src|width]]` so they can
// be re-rendered cleanly (moving the live nodes fails — in Live Preview they
// are often unhydrated placeholders that never load once relocated).
function reconstructFigureLines(content) {
  const lines = [];
  let current = "";
  const flush = () => {
    lines.push(current);
    current = "";
  };
  const walk = (node) => {
    for (const child of node.childNodes || []) {
      if (child.nodeType === 3) {
        current += child.nodeValue || "";
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (tag === "BR") {
        flush();
      } else if (tag === "IMG" || child.matches?.(".internal-embed, .image-embed")) {
        const src = child.getAttribute?.("src") || child.getAttribute?.("alt") || "";
        const width = child.getAttribute?.("width") || "";
        if (src) current += width ? `![[${src}|${width}]]` : `![[${src}]]`;
      } else if (tag === "P" || tag === "DIV") {
        if (current.trim()) flush();
        walk(child);
        if (current.trim()) flush();
      } else {
        walk(child);
      }
    }
  };
  walk(content);
  if (current.trim()) flush();
  return lines.map((l) => l.trim()).filter((l) => l.length);
}

// Fallback for when the section source is unavailable (notably Live Preview,
// where getSectionInfo returns nothing). Reconstructs the figure's lines from
// the rendered DOM and parses them exactly like the source path, so entries
// carry `imageMarkdown` (re-rendered, not moved) and each image keeps its own
// caption.
function extractMultiFromDom(content) {
  if (!content) return { entries: [], overallCaption: "", isMulti: false };

  const lines = reconstructFigureLines(content);
  const entries = [];
  const overallLines = [];
  for (const line of lines) {
    if (ANCHOR_LINE_RE.test(line)) continue;
    const lead = line.match(IMAGE_LEAD_RE);
    if (lead) {
      let label = "";
      let caption = (lead[2] || "").trim();
      const labelled = caption.match(ENTRY_LABEL_RE);
      if (labelled) {
        label = labelled[1].trim();
        caption = (labelled[2] || "").trim();
      }
      caption = caption.replace(CAPTION_MARKER_RE, "").trim();
      entries.push({ imageMarkdown: lead[1], label, caption });
    } else {
      overallLines.push(line.replace(CAPTION_MARKER_RE, "").trim());
    }
  }

  return {
    entries,
    overallCaption: overallLines.join("\n").trim(),
    isMulti: entries.length >= 2
  };
}

function closestWithin(el, selector, boundary) {
  let current = el;
  let found = null;
  while (current && current !== boundary) {
    if (current.matches?.(selector)) found = current;
    current = current.parentElement;
  }
  if (boundary?.matches?.(selector)) found = boundary;
  return found;
}

function imageVisualForBlock(imageBlock) {
  if (!imageBlock) return null;
  const imageNode = imageBlock.matches?.(".internal-embed, .image-embed, img")
    ? imageBlock
    : imageBlock.querySelector(".internal-embed, .image-embed, img");
  if (!imageNode) return null;
  if (imageNode.matches?.("img")) {
    return closestWithin(imageNode, ".internal-embed, .image-embed", imageBlock) || imageNode;
  }
  return imageNode;
}

function moveImageVisualIntoHolder(imageHolder, imageBlock, doc) {
  const visual = imageVisualForBlock(imageBlock);
  if (!visual) {
    if (imageBlock) imageHolder.appendChild(imageBlock);
    return;
  }

  const shell = doc.createElement("div");
  shell.className = "tufte-fig-image-block";
  shell.appendChild(visual);
  imageHolder.appendChild(shell);
}

function emptyElement(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

async function renderMarkdown(app, markdown, el, sourcePath, component) {
  if (MarkdownRenderer.render) {
    await MarkdownRenderer.render(app, markdown || " ", el, sourcePath, component);
    return;
  }
  await MarkdownRenderer.renderMarkdown(markdown || " ", el, sourcePath, component);
}

function prependFigureLabel(holder, titleText) {
  if (!holder || !titleText) return false;
  const captionPara = innerParaForHolder(holder);
  if (!captionPara) return false;
  const existing = captionPara.querySelector(
    ":scope > .tufte-fig-label:first-child"
  );
  if (existing) return true;

  const label = (captionPara.ownerDocument || document).createElement("span");
  label.className = "tufte-fig-label";
  const labelText = /\.$/.test(titleText) ? titleText : `${titleText}.`;
  label.textContent = `${labelText} `;
  captionPara.insertBefore(label, captionPara.firstChild);
  return true;
}

// Insert a verbatim red-italic label (e.g. "(a)") at the start of a holder's
// caption paragraph. Unlike prependFigureLabel it adds no trailing period.
function insertLabelSpan(holder, labelText) {
  if (!holder || !labelText) return false;
  const para = innerParaForHolder(holder);
  const target = para || holder;
  const existing = target.querySelector?.(":scope > .tufte-fig-label:first-child");
  if (existing) return true;
  const span = (target.ownerDocument || document).createElement("span");
  span.className = "tufte-fig-label";
  span.textContent = `${labelText} `;
  target.insertBefore(span, target.firstChild);
  return true;
}

// Render a caption holder: the caption markdown, optionally prefixed with a
// label. `figureLabel` (e.g. "Fig. 4.") gets a trailing period; an entry
// label (e.g. "(a)") is inserted verbatim.
async function buildMultiCaption(app, doc, sourcePath, component, className, labelText, captionMarkdown, isFigureLabel) {
  const holder = doc.createElement("div");
  holder.className = className;
  await renderMarkdown(app, captionMarkdown || " ", holder, sourcePath, component);
  if (labelText) {
    if (isFigureLabel) prependFigureLabel(holder, labelText);
    else insertLabelSpan(holder, labelText);
  }
  return holder;
}

// Build the canonical multi-image DOM. Modes differ only in where captions
// sit: mode 1 (figure) lists all captions in the margin column; modes 2/3
// (figure-full / figure-margin) place each caption under its image and the
// overall caption after the row.
async function renderMultiFigure(callout, content, ctx, app, component, calloutType, data) {
  const doc = callout.ownerDocument || document;
  const sourcePath =
    ctx?.sourcePath || app?.workspace?.getActiveFile?.()?.path || "";
  const titleEl = callout.querySelector(".callout-title");
  const titleInner = callout.querySelector(".callout-title-inner");
  const titleText = (titleInner?.textContent || titleEl?.textContent || "").trim();
  const perCellCaption = calloutType !== "figure";

  const imageHolder = doc.createElement("div");
  imageHolder.className = "tufte-fig-image-holder";
  const row = doc.createElement("div");
  row.className = "tufte-fig-row";
  imageHolder.appendChild(row);

  for (const entry of data.entries) {
    const cell = doc.createElement("div");
    cell.className = "tufte-fig-cell";
    const imgWrap = doc.createElement("div");
    imgWrap.className = "tufte-fig-cell-image";
    if (entry.imageNode) {
      const shell = doc.createElement("div");
      shell.className = "tufte-fig-image-block";
      shell.appendChild(entry.imageNode);
      imgWrap.appendChild(shell);
    } else {
      await renderMarkdown(app, entry.imageMarkdown, imgWrap, sourcePath, component);
    }
    cell.appendChild(imgWrap);
    if (perCellCaption && (entry.label || entry.caption)) {
      cell.appendChild(
        await buildMultiCaption(
          app, doc, sourcePath, component,
          "tufte-fig-cell-caption",
          entry.label ? `(${entry.label})` : "",
          entry.caption, false
        )
      );
    }
    row.appendChild(cell);
  }

  const captionHolder = doc.createElement("div");
  captionHolder.className = "tufte-fig-caption-holder";

  if (!perCellCaption) {
    // Mode 1: every individual caption lives in the margin column.
    const list = doc.createElement("div");
    list.className = "tufte-fig-caption-list";
    for (const entry of data.entries) {
      if (!entry.label && !entry.caption) continue;
      list.appendChild(
        await buildMultiCaption(
          app, doc, sourcePath, component,
          "tufte-fig-caption-item",
          entry.label ? `(${entry.label})` : "",
          entry.caption, false
        )
      );
    }
    if (list.childElementCount) captionHolder.appendChild(list);
  }

  if (data.overallCaption || titleText) {
    captionHolder.appendChild(
      await buildMultiCaption(
        app, doc, sourcePath, component,
        "tufte-fig-overall-caption",
        titleText, data.overallCaption, true
      )
    );
    if (titleText) titleEl?.classList.add("tufte-figure-title-hidden");
  }

  emptyElement(content);
  content.appendChild(imageHolder);
  content.appendChild(captionHolder);

  callout.classList.add("tufte-fig-multi");
  callout.classList.add("tufte-fig-sized"); // entries carry native widths
  callout.dataset.tufteFigureDecorated = "1";
}

async function decorateDefaultFigure(callout, ctx, app, component, sectionEl) {
  if (
    callout.dataset.tufteFigureDecorated === "1" ||
    callout.dataset.tufteFigureDecorated === "pending"
  ) {
    return;
  }
  callout.dataset.tufteFigureDecorated = "pending";

  try {
    const titleEl = callout.querySelector(".callout-title");
    const titleInner = callout.querySelector(".callout-title-inner");
    const titleText = (titleInner?.textContent || titleEl?.textContent || "").trim();

    const content = callout.querySelector(".callout-content");
    if (!content) {
      callout.dataset.tufteFigureDecorated = "1";
      return;
    }

    let multi = extractMultiFigure(ctx, callout, sectionEl, "figure");
    if (!multi.isMulti) {
      const dom = extractMultiFromDom(content);
      if (dom.isMulti) multi = dom;
    }
    if (multi.isMulti) {
      await renderMultiFigure(callout, content, ctx, app, component, "figure", multi);
      return;
    }

    const { imageMarkdown, captionMarkdown } = extractDefaultFigureMarkdown(
      ctx,
      callout,
      sectionEl
    );
    callout.classList.toggle("tufte-fig-sized", embedHasSize(imageMarkdown));
    const { imageBlock, captionBlock } = findDefaultFigureParts(content);
    const doc = callout.ownerDocument || document;
    const imageHolder = doc.createElement("div");
    imageHolder.className = "tufte-fig-image-holder";
    const captionHolder = doc.createElement("div");
    captionHolder.className = "tufte-fig-caption-holder";

    if (imageMarkdown) {
      await renderMarkdown(app, imageMarkdown, imageHolder, ctx?.sourcePath || "", component);
    } else {
      moveImageVisualIntoHolder(imageHolder, imageBlock, doc);
    }

    if (captionMarkdown) {
      await renderMarkdown(app, captionMarkdown, captionHolder, ctx?.sourcePath || "", component);
    } else if (captionBlock && captionBlock !== imageBlock) {
      captionHolder.appendChild(captionBlock);
    } else {
      const synthetic = doc.createElement("p");
      captionHolder.appendChild(synthetic);
    }

    const labelInserted = prependFigureLabel(captionHolder, titleText);
    if (labelInserted) titleEl?.classList.add("tufte-figure-title-hidden");

    emptyElement(content);
    content.appendChild(imageHolder);
    content.appendChild(captionHolder);

    callout.dataset.tufteFigureDecorated = "1";
  } catch (err) {
    console.error("Tufte Figures: failed to decorate default figure", err);
    delete callout.dataset.tufteFigureDecorated;
  }
}

async function decorateFullFigure(callout, ctx, app, component, sectionEl) {
  if (
    callout.dataset.tufteFigureDecorated === "1" ||
    callout.dataset.tufteFigureDecorated === "pending"
  ) {
    return;
  }
  callout.dataset.tufteFigureDecorated = "pending";

  try {
    const titleEl = callout.querySelector(".callout-title");
    const titleInner = callout.querySelector(".callout-title-inner");
    const titleText = (titleInner?.textContent || titleEl?.textContent || "").trim();
    const content = callout.querySelector(".callout-content");
    if (!content) {
      callout.dataset.tufteFigureDecorated = "1";
      return;
    }

    let multi = extractMultiFigure(ctx, callout, sectionEl, "figure-full");
    if (!multi.isMulti) {
      const dom = extractMultiFromDom(content);
      if (dom.isMulti) multi = dom;
    }
    if (multi.isMulti) {
      await renderMultiFigure(callout, content, ctx, app, component, "figure-full", multi);
      return;
    }

    const { imageMarkdown, captionMarkdown } = extractFullFigureMarkdown(
      ctx,
      callout,
      sectionEl
    );
    callout.classList.toggle("tufte-fig-sized", embedHasSize(imageMarkdown));
    const { imageBlock, captionBlock } = findDefaultFigureParts(content);
    const doc = callout.ownerDocument || document;
    const imageHolder = doc.createElement("div");
    imageHolder.className = "tufte-fig-image-holder";
    const captionHolder = doc.createElement("div");
    captionHolder.className = "tufte-fig-caption-holder";

    if (imageMarkdown) {
      await renderMarkdown(app, imageMarkdown, imageHolder, ctx?.sourcePath || "", component);
    } else {
      moveImageVisualIntoHolder(imageHolder, imageBlock, doc);
    }

    if (captionMarkdown) {
      await renderMarkdown(app, captionMarkdown, captionHolder, ctx?.sourcePath || "", component);
    } else if (captionBlock && captionBlock !== imageBlock) {
      captionHolder.appendChild(captionBlock);
    } else {
      const synthetic = doc.createElement("p");
      captionHolder.appendChild(synthetic);
    }

    const labelInserted = prependFigureLabel(captionHolder, titleText);
    if (labelInserted) titleEl?.classList.add("tufte-figure-title-hidden");

    emptyElement(content);
    content.appendChild(imageHolder);
    content.appendChild(captionHolder);

    callout.dataset.tufteFigureDecorated = "1";
  } catch (err) {
    console.error("Tufte Figures: failed to decorate full-width figure", err);
    delete callout.dataset.tufteFigureDecorated;
  }
}

async function decorateMarginFigure(callout, ctx, app, component, sectionEl) {
  if (
    callout.dataset.tufteFigureDecorated === "1" ||
    callout.dataset.tufteFigureDecorated === "pending"
  ) {
    return;
  }
  callout.dataset.tufteFigureDecorated = "pending";

  try {
    const titleEl = callout.querySelector(".callout-title");
    const titleInner = callout.querySelector(".callout-title-inner");
    const titleText = (titleInner?.textContent || titleEl?.textContent || "").trim();
    const content = callout.querySelector(".callout-content");
    if (!content) {
      callout.dataset.tufteFigureDecorated = "1";
      return;
    }

    let multi = extractMultiFigure(ctx, callout, sectionEl, "figure-margin");
    if (!multi.isMulti) {
      const dom = extractMultiFromDom(content);
      if (dom.isMulti) multi = dom;
    }
    if (multi.isMulti) {
      await renderMultiFigure(callout, content, ctx, app, component, "figure-margin", multi);
      return;
    }

    const { imageMarkdown, captionMarkdown } = extractMarginFigureMarkdown(
      ctx,
      callout,
      sectionEl
    );
    callout.classList.toggle("tufte-fig-sized", embedHasSize(imageMarkdown));
    const { imageBlock, captionBlock } = findDefaultFigureParts(content);
    const doc = callout.ownerDocument || document;
    const imageHolder = doc.createElement("div");
    imageHolder.className = "tufte-fig-image-holder";
    const captionHolder = doc.createElement("div");
    captionHolder.className = "tufte-fig-caption-holder";

    if (imageMarkdown) {
      await renderMarkdown(app, imageMarkdown, imageHolder, ctx?.sourcePath || "", component);
    } else {
      moveImageVisualIntoHolder(imageHolder, imageBlock, doc);
    }

    if (captionMarkdown) {
      await renderMarkdown(app, captionMarkdown, captionHolder, ctx?.sourcePath || "", component);
    } else if (captionBlock && captionBlock !== imageBlock) {
      captionHolder.appendChild(captionBlock);
    } else {
      const synthetic = doc.createElement("p");
      captionHolder.appendChild(synthetic);
    }

    const labelInserted = prependFigureLabel(captionHolder, titleText);
    if (labelInserted) titleEl?.classList.add("tufte-figure-title-hidden");

    emptyElement(content);
    content.appendChild(imageHolder);
    content.appendChild(captionHolder);

    callout.dataset.tufteFigureDecorated = "1";
  } catch (err) {
    console.error("Tufte Figures: failed to decorate margin figure", err);
    delete callout.dataset.tufteFigureDecorated;
  }
}

function decorateLegacyMarginFigure(callout) {
  if (callout.dataset.tufteFigureDecorated === "1") return;
  // Only treat the marginnote as a *figure* when it contains an image.
  // Plain marginnotes (the sidenotes plugin owns those) stay untouched.
  if (!callout.querySelector(".internal-embed.image-embed, img")) return;
  const content = callout.querySelector(".callout-content");
  if (!content) {
    callout.dataset.tufteFigureDecorated = "1";
    return;
  }
  // Find the first text node anywhere inside the content whose value starts
  // with "Fig. N." (or "Figure N.") and wrap that prefix in a coloured span.
  const walker = (callout.ownerDocument || document).createTreeWalker(
    content,
    NodeFilter.SHOW_TEXT,
    null
  );
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue) continue;
    const m = node.nodeValue.match(/^\s*(Fig\.?|Figure)\s+\d+\.\s*/);
    if (!m) continue;
    const labelText = m[0].trim();
    const rest = node.nodeValue.slice(m[0].length);
    const span = (node.ownerDocument || document).createElement("span");
    span.className = "tufte-fig-label";
    span.textContent = `${labelText} `;
    const after = (node.ownerDocument || document).createTextNode(rest);
    const parent = node.parentNode;
    if (!parent) break;
    parent.insertBefore(span, node);
    parent.insertBefore(after, node);
    parent.removeChild(node);
    break;
  }
  callout.dataset.tufteFigureDecorated = "1";
}

function hideOrphanFigureAnchors(root) {
  // Block IDs (`^fig-N`) attach to the preceding block via Obsidian's
  // parser, but on some builds the line still leaks into the rendered DOM
  // as a bare paragraph. Hide any paragraph whose entire visible text is
  // an anchor token so the figure ends cleanly.
  matchingElements(root, "p").forEach((p) => {
    const t = (p.textContent || "").trim();
    if (/^\^fig-\d+$/.test(t)) p.style.display = "none";
  });
}

// --- modal ---------------------------------------------------------------

class FigureReferenceModal extends Modal {
  constructor(app, plugin, editor) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
    this.number = defaultFigureReferenceNumber(editor);
    this.referenceInput = null;
  }

  onOpen() {
    const { contentEl } = this;
    const known = figureAnchorNumbers(this.editor.getValue());
    contentEl.empty();
    contentEl.addClass("tufte-figure-modal");
    contentEl.createEl("h3", { text: "Insert figure reference" });

    new Setting(contentEl)
      .setName("Figure number")
      .setDesc(
        known.length
          ? `Detected figures: ${known.join(", ")}.`
          : "No figure anchors detected in this note yet."
      )
      .addText((t) => {
        t.setValue(this.number).onChange((v) => {
          this.number = v.trim();
          this.updateReference();
        });
        t.inputEl.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter") {
            evt.preventDefault();
            this.doInsert();
          }
        });
        window.setTimeout(() => {
          t.inputEl.focus();
          t.inputEl.select();
        }, 0);
      });

    new Setting(contentEl)
      .setName("Reference")
      .setDesc("This will be inserted at the cursor.")
      .addText((t) => {
        this.referenceInput = t;
        t.setValue(this.referenceText());
        t.inputEl.readOnly = true;
      });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Insert reference")
        .setCta()
        .onClick(() => this.doInsert())
    );
  }

  referenceText() {
    return figureReferenceText(this.number);
  }

  updateReference() {
    if (this.referenceInput) this.referenceInput.setValue(this.referenceText());
  }

  doInsert() {
    const number = (this.number || "").trim();
    if (!/^\d+$/.test(number)) {
      new Notice("Tufte Figures: enter a figure number.");
      return;
    }
    insertInlineText(this.editor, figureReferenceText(number));
    this.editor.focus?.();
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class FigureModal extends Modal {
  constructor(app, plugin, editor, opts) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
    this.opts = opts || {};
    this.sourcePath =
      this.opts.sourcePath || app.workspace.getActiveFile()?.path || "";
    this.isEdit = !!this.opts.editRange;

    this.mode = "default";
    this.embed = this.opts.embed || "";
    this.alt = "";
    this.width = "";
    this.height = "";
    this.caption = "";
    this.number = String(nextFigureNumber(editor.getValue()));
    this.ratio = null;
    this.indicatorInput = null;
    this.widthInput = null;
    this.heightInput = null;

    // Multiple-images tab state.
    this.tab = "basic";
    this.rowHeight = 200;
    this.overallCaption = "";
    this.entries = [];
    this.entriesEl = null;

    // Image-quilt tab state. Source tiles are held in memory (bytes) and are
    // only persisted under .obsidian/ on generate, so the vault shows the
    // single generated PNG and nothing else.
    this.quilt = {
      id: null,
      dir: null,
      pngPath: null,
      tiles: [], // { bytes:Uint8Array, ext, name, ratio, url, imgEl }
      rowHeight: 150,
      zoom: 100,
      grayscale: false,
      loading: false
    };
    this.quiltStageEl = null;
    this._objectUrls = [];
    this._quiltRowSlider = null;
    this._quiltZoomSlider = null;
    this._quiltGrayToggle = null;

    const edit = this.opts.edit;
    if (edit) {
      // Editing an existing figure: pre-fill from its parsed block.
      this.mode = edit.mode || "default";
      if (edit.number) this.number = edit.number;
      if (edit.images.length >= 2) {
        this.tab = "multi";
        this.entries = edit.images.map((im, i) => {
          const p = parseEmbed(im.embed);
          return {
            embed: im.embed,
            name: p.path || im.embed,
            label: im.label || String.fromCharCode(97 + i),
            caption: im.caption || "",
            ratio: null,
            width: p.width || "",
            src: ""
          };
        });
        this.overallCaption = edit.overall || "";
      } else {
        const im = edit.images[0];
        if (im) {
          this.embed = im.embed;
          const p = parseEmbed(im.embed);
          this.alt = p.alt || "";
          this.width = p.width || "";
          this.height = p.height || "";
        }
        this.caption = (im && im.caption) || edit.overall || "";
      }
    } else {
      // Insert flow: seed alt/size and the first multi-tab entry from the embed.
      const parsed = parseEmbed(this.embed);
      this.alt = this.opts.altDefault || parsed.alt || "";
      this.width = parsed.width || "";
      this.height = parsed.height || "";
      if (this.embed) {
        this.entries.push({
          embed: this.embed,
          name: parsed.path || this.embed,
          label: "a",
          caption: "",
          ratio: null,
          width: "",
          src: ""
        });
      }
    }

    // Open straight onto a chosen tab (e.g. the "Insert image quilt" command).
    if (this.opts.openTab) this.tab = this.opts.openTab;
    // Re-editing an existing quilt: the figure embeds quilt-<id>.png and a
    // saved config sidecar was found, so jump to the quilt tab and lazy-load it.
    if (this.opts.quilt) {
      this.tab = "quilt";
      this.quilt.id = this.opts.quilt.id;
      this.quilt.dir = this.opts.quilt.dir;
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("tufte-figure-modal");
    contentEl.createEl("h3", {
      text: this.isEdit ? "Edit Tufte figure" : "Insert Tufte figure"
    });

    const tabs = contentEl.createDiv({ cls: "tufte-fig-tabs" });
    const basicBtn = tabs.createEl("button", { text: "Basic" });
    const multiBtn = tabs.createEl("button", { text: "Multiple images" });
    const quiltBtn = tabs.createEl("button", { text: "Image quilt" });
    const basicEl = contentEl.createDiv({ cls: "tufte-fig-tab-panel" });
    const multiEl = contentEl.createDiv({ cls: "tufte-fig-tab-panel" });
    const quiltEl = contentEl.createDiv({ cls: "tufte-fig-tab-panel" });

    const setTab = (tab) => {
      this.tab = tab;
      basicBtn.toggleClass("is-active", tab === "basic");
      multiBtn.toggleClass("is-active", tab === "multi");
      quiltBtn.toggleClass("is-active", tab === "quilt");
      basicEl.style.display = tab === "basic" ? "" : "none";
      multiEl.style.display = tab === "multi" ? "" : "none";
      quiltEl.style.display = tab === "quilt" ? "" : "none";
      // The stage needs a real width to pack tiles; it's 0 while hidden, so
      // (re)render on switch-in.
      if (tab === "quilt") this.renderQuiltStage();
    };
    basicBtn.onclick = () => setTab("basic");
    multiBtn.onclick = () => setTab("multi");
    quiltBtn.onclick = () => setTab("quilt");

    this.buildBasicTab(basicEl);
    this.buildMultiTab(multiEl);
    this.buildQuiltTab(quiltEl);
    setTab(this.tab);

    this.resolveNaturalSize();
  }

  buildBasicTab(contentEl) {
    new Setting(contentEl)
      .setName("Image link")
      .setDesc("The embed inserted into the figure.")
      .addText((t) =>
        t.setValue(this.embed).onChange((v) => {
          this.embed = v;
          this.resolveNaturalSize();
        })
      );

    new Setting(contentEl).setName("Display").addDropdown((d) => {
      d.addOption("default", "Default — image in column, caption in margin");
      d.addOption("full", "Full-width — image spans column + margin");
      d.addOption("margin", "Margin figure — [!figure-margin]");
      d.setValue(this.mode).onChange((v) => {
        this.mode = v;
      });
    });

    new Setting(contentEl)
      .setName("Figure number")
      .setDesc("Auto-suggested; edit to set it manually.")
      .addText((t) =>
        t.setValue(this.number).onChange((v) => {
          this.number = v.trim();
          this.updateIndicator();
        })
      );

    new Setting(contentEl)
      .setName("Alt text")
      .addText((t) =>
        t.setValue(this.alt).onChange((v) => {
          this.alt = v;
        })
      );

    new Setting(contentEl).setName("Caption").addTextArea((t) => {
      t.setValue(this.caption).onChange((v) => {
        this.caption = v;
      });
      t.inputEl.rows = 3;
      t.inputEl.style.width = "100%";
    });

    new Setting(contentEl)
      .setName("Size (px)")
      .setDesc("Width × height. Ratio is locked — editing one updates the other. Leave blank for the original size.")
      .addText((t) => {
        this.widthInput = t;
        t.setPlaceholder("width");
        t.setValue(this.width);
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.inputEl.style.width = "5.5em";
        t.onChange((v) => this.onWidthChanged(v));
      })
      .addText((t) => {
        this.heightInput = t;
        t.setPlaceholder("height");
        t.setValue(this.height);
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.inputEl.style.width = "5.5em";
        t.onChange((v) => this.onHeightChanged(v));
      });

    const indicator = new Setting(contentEl)
      .setName("In-text reference")
      .setDesc("Clickable link to this figure — copy it into your prose.");
    indicator.addText((t) => {
      this.indicatorInput = t;
      t.setValue(this.indicatorText());
      t.inputEl.readOnly = true;
    });
    indicator.addButton((b) =>
      b.setButtonText("Copy").onClick(async () => {
        try {
          await navigator.clipboard.writeText(this.indicatorText());
          new Notice("Figure reference copied");
        } catch {
          new Notice("Couldn't access the clipboard");
        }
      })
    );

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(this.isEdit ? "Save figure" : "Insert figure")
        .setCta()
        .onClick(() => this.doInsert())
    );
  }

  buildMultiTab(contentEl) {
    contentEl.createEl("p", {
      cls: "tufte-fig-multi-hint",
      text: "A row of up to 5 images sharing one caption. Heights are equalised; each image keeps its ratio."
    });

    new Setting(contentEl).setName("Display").addDropdown((d) => {
      d.addOption("default", "Default — row in column, captions in margin");
      d.addOption("full", "Full-width — row spans column + margin");
      // No margin mode: a row of images doesn't lay out well in the margin.
      d.setValue(this.mode === "margin" ? "default" : this.mode).onChange((v) => {
        this.mode = v;
      });
    });

    new Setting(contentEl)
      .setName("Figure number")
      .addText((t) =>
        t.setValue(this.number).onChange((v) => {
          this.number = v.trim();
        })
      );

    new Setting(contentEl)
      .setName("Row height (px)")
      .setDesc("Shared height; per-image widths follow each ratio.")
      .addText((t) => {
        t.setValue(String(this.rowHeight));
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.inputEl.style.width = "6em";
        t.onChange((v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) {
            this.rowHeight = n;
            this.refreshEntryWidths();
          }
        });
      });

    this.entriesEl = contentEl.createDiv({ cls: "tufte-fig-entries" });
    this.entries.forEach((entry) => this.loadEntryRatio(entry));
    this.renderEntries();

    const zone = contentEl.createDiv({ cls: "tufte-fig-dropzone" });
    zone.createSpan({ cls: "tufte-fig-dropzone-plus", text: "+" });
    zone.createSpan({
      cls: "tufte-fig-dropzone-text",
      text: "Drag images here, or click to browse"
    });
    zone.addEventListener("click", () => this.pickImage());
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.addClass("is-dragover");
    });
    zone.addEventListener("dragleave", () => zone.removeClass("is-dragover"));
    zone.addEventListener("drop", (e) => this.onZoneDrop(e, zone));

    new Setting(contentEl).setName("Overall caption").addTextArea((t) => {
      t.setValue(this.overallCaption).onChange((v) => {
        this.overallCaption = v;
      });
      t.inputEl.rows = 2;
      t.inputEl.style.width = "100%";
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(this.isEdit ? "Save figure" : "Insert figure")
        .setCta()
        .onClick(() => this.doInsertMulti())
    );
  }

  renderEntries() {
    const el = this.entriesEl;
    if (!el) return;
    el.empty();
    this.entries.forEach((entry, i) => {
      const row = el.createDiv({ cls: "tufte-fig-entry" });
      if (entry.src) {
        const thumb = row.createEl("img", { cls: "tufte-fig-entry-thumb" });
        thumb.src = entry.src;
      } else {
        row.createDiv({ cls: "tufte-fig-entry-thumb tufte-fig-entry-thumb-empty" });
      }
      row.createSpan({ cls: "tufte-fig-entry-name", text: entry.name || entry.embed });

      const lab = row.createEl("input", { type: "text" });
      lab.value = entry.label;
      lab.placeholder = "a";
      lab.addClass("tufte-fig-entry-label");
      lab.oninput = () => {
        entry.label = lab.value;
      };

      const cap = row.createEl("input", { type: "text" });
      cap.value = entry.caption;
      cap.placeholder = "individual caption";
      cap.addClass("tufte-fig-entry-caption");
      cap.oninput = () => {
        entry.caption = cap.value;
      };

      const rm = row.createEl("button", { text: "✕", cls: "tufte-fig-entry-remove" });
      rm.onclick = () => {
        this.entries.splice(i, 1);
        this.renderEntries();
      };
    });
  }

  pickImage() {
    if (this.entries.length >= 5) {
      new Notice("Tufte Figures: a row holds at most 5 images.");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (file) await this.addImageFile(file);
    };
    input.click();
  }

  async addImageFile(file) {
    try {
      const ext = extFromType(file.type) || fileExt(file.name) || "png";
      const baseName =
        file.name && file.name.toLowerCase() !== "image.png"
          ? file.name
          : `pasted-image-${Date.now()}.${ext}`;
      const path = await this.app.fileManager.getAvailablePathForAttachment(
        baseName,
        this.sourcePath
      );
      const buffer = await file.arrayBuffer();
      const tfile = await this.app.vault.createBinary(path, buffer);
      this.addEntryFromTFile(tfile);
    } catch (e) {
      console.error("tufte-figures: failed to save image", e);
      new Notice("Tufte Figures: couldn't save the image.");
    }
  }

  addEntryFromTFile(tfile) {
    if (this.entries.length >= 5) return;
    const entry = {
      embed: this.plugin.buildEmbed(tfile, this.sourcePath),
      name: tfile.basename || tfile.name,
      label: String.fromCharCode(97 + this.entries.length),
      caption: "",
      ratio: null,
      width: ""
    };
    this.entries.push(entry);
    this.loadEntryRatio(entry);
    this.renderEntries();
  }

  async onZoneDrop(evt, zone) {
    evt.preventDefault();
    evt.stopPropagation();
    zone.removeClass("is-dragover");

    // External image files.
    const files = Array.from((evt.dataTransfer && evt.dataTransfer.files) || []).filter(
      (f) => f.type && f.type.startsWith("image/")
    );
    if (files.length) {
      for (const f of files) {
        if (this.entries.length >= 5) break;
        await this.addImageFile(f);
      }
      return;
    }

    // Internal vault images (dragged from the file explorer); fall back to the
    // plugin's dragstart snapshot when the drag manager is already cleared.
    const tfiles = draggedImageFiles(this.app);
    const internal = tfiles.length ? tfiles : this.plugin._lastDraggedImages || [];
    if (internal.length) {
      for (const tf of internal) this.addEntryFromTFile(tf);
      return;
    }

    let text = "";
    try {
      text = evt.dataTransfer?.getData("text/plain") || "";
    } catch {}
    const linkpath = linkpathFromDropText(text);
    if (linkpath) {
      const tf = this.app.metadataCache.getFirstLinkpathDest(linkpath, this.sourcePath);
      if (isImageTFile(tf)) this.addEntryFromTFile(tf);
    }
  }

  loadEntryRatio(entry) {
    const parsed = parseEmbed(entry.embed);
    let src = "";
    if (parsed.kind === "wiki") {
      const tf = this.app.metadataCache.getFirstLinkpathDest(
        (parsed.path || "").split("#")[0],
        this.sourcePath
      );
      if (tf) {
        try {
          src = this.app.vault.getResourcePath(tf);
        } catch {}
      }
    } else if (parsed.kind === "md") {
      src = parsed.path;
    }
    entry.src = src;
    if (!src) return;
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth && img.naturalHeight) {
        entry.ratio = img.naturalWidth / img.naturalHeight;
        // Keep an existing width (an edited figure's own size); only derive
        // it for fresh entries that don't carry one yet.
        if (!entry.width) {
          entry.width = String(Math.round(this.rowHeight * entry.ratio));
        }
      }
    };
    img.src = src;
  }

  refreshEntryWidths() {
    for (const entry of this.entries) {
      if (entry.ratio) entry.width = String(Math.round(this.rowHeight * entry.ratio));
    }
  }

  doInsertMulti() {
    if (this.entries.length < 2) {
      new Notice("Tufte Figures: add at least 2 images, or use the Basic tab.");
      return;
    }
    // Fill in any missing widths without clobbering ones already set (changing
    // the row height runs refreshEntryWidths, which intentionally rescales all).
    for (const e of this.entries) {
      if (e.ratio && !e.width) e.width = String(Math.round(this.rowHeight * e.ratio));
    }
    // Margin mode isn't offered for rows; fall back to default if inherited.
    const mode = this.mode === "margin" ? "default" : this.mode;
    const block = buildMultiFigureBlock(mode, {
      entries: this.entries.map((e) => ({
        embed: e.embed,
        label: (e.label || "").trim(),
        caption: (e.caption || "").trim(),
        width: e.width || ""
      })),
      overallCaption: this.overallCaption.trim(),
      number: this.number || "1",
      labelPrefix: this.plugin.settings.labelPrefix
    });
    this.commitBlock(block);
    this.close();
  }

  // --- image-quilt tab ---------------------------------------------------

  buildQuiltTab(contentEl) {
    contentEl.createEl("p", {
      cls: "tufte-fig-multi-hint",
      text:
        "Combine many images into one quilt — a tight grid of uniform-height tiles. " +
        "Drag tiles to reorder, ✕ to remove. Generates a single transparent PNG inserted " +
        "as a figure; re-editable later via 'Edit figure at cursor'."
    });

    new Setting(contentEl).setName("Display").addDropdown((d) => {
      d.addOption("default", "Default — quilt in column, caption in margin");
      d.addOption("full", "Full-width — quilt spans column + margin");
      // No margin mode: a wide quilt doesn't lay out well in the margin.
      d.setValue(this.mode === "margin" ? "default" : this.mode).onChange((v) => {
        this.mode = v;
      });
    });

    new Setting(contentEl)
      .setName("Figure number")
      .addText((t) =>
        t.setValue(this.number).onChange((v) => {
          this.number = v.trim();
        })
      );

    new Setting(contentEl)
      .setName("Tile height (px)")
      .setDesc("Shared height of every tile; widths follow each image's ratio.")
      .addSlider((s) => {
        this._quiltRowSlider = s;
        s.setLimits(40, 320, 5);
        s.setValue(this.quilt.rowHeight);
        s.setDynamicTooltip();
        s.onChange((v) => {
          this.quilt.rowHeight = v;
          this.renderQuiltStage();
        });
      });

    new Setting(contentEl)
      .setName("Zoom (%)")
      .setDesc("Magnify and crop the image inside each tile.")
      .addSlider((s) => {
        this._quiltZoomSlider = s;
        s.setLimits(100, 300, 5);
        s.setValue(this.quilt.zoom);
        s.setDynamicTooltip();
        s.onChange((v) => {
          this.quilt.zoom = v;
          this.renderQuiltStage();
        });
      });

    new Setting(contentEl)
      .setName("Grayscale")
      .setDesc("Render the quilt in black and white.")
      .addToggle((t) => {
        this._quiltGrayToggle = t;
        t.setValue(this.quilt.grayscale).onChange((v) => {
          this.quilt.grayscale = v;
          this.renderQuiltStage();
        });
      });

    this.quiltStageEl = contentEl.createDiv({ cls: "tufte-quilt-stage" });

    const zone = contentEl.createDiv({ cls: "tufte-fig-dropzone" });
    zone.createSpan({ cls: "tufte-fig-dropzone-plus", text: "+" });
    zone.createSpan({
      cls: "tufte-fig-dropzone-text",
      text: "Drag images here, or click to browse"
    });
    zone.addEventListener("click", () => this.pickQuiltImages());
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.addClass("is-dragover");
    });
    zone.addEventListener("dragleave", () => zone.removeClass("is-dragover"));
    zone.addEventListener("drop", (e) => this.onQuiltZoneDrop(e, zone));

    new Setting(contentEl).setName("Caption").addTextArea((t) => {
      t.setValue(this.caption).onChange((v) => {
        this.caption = v;
      });
      t.inputEl.rows = 2;
      t.inputEl.style.width = "100%";
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(this.isEdit ? "Save quilt" : "Generate & insert quilt")
        .setCta()
        .onClick(() => this.doInsertQuilt())
    );

    // Re-edit: pull the saved tiles + settings in from the sidecar.
    if (this.opts.quilt) this.loadQuiltFromConfig();
  }

  pickQuiltImages() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      for (const f of files) await this.addQuiltImageFile(f);
    };
    input.click();
  }

  async onQuiltZoneDrop(evt, zone) {
    evt.preventDefault();
    evt.stopPropagation();
    zone.removeClass("is-dragover");

    const files = Array.from((evt.dataTransfer && evt.dataTransfer.files) || []).filter(
      (f) => f.type && f.type.startsWith("image/")
    );
    if (files.length) {
      for (const f of files) await this.addQuiltImageFile(f);
      return;
    }

    const tfiles = draggedImageFiles(this.app);
    const internal = tfiles.length ? tfiles : this.plugin._lastDraggedImages || [];
    if (internal.length) {
      for (const tf of internal) await this.addQuiltTileFromTFile(tf);
      return;
    }

    let text = "";
    try {
      text = evt.dataTransfer?.getData("text/plain") || "";
    } catch {}
    const linkpath = linkpathFromDropText(text);
    if (linkpath) {
      const tf = this.app.metadataCache.getFirstLinkpathDest(linkpath, this.sourcePath);
      if (isImageTFile(tf)) await this.addQuiltTileFromTFile(tf);
    }
  }

  async addQuiltImageFile(file) {
    try {
      const ext = extFromType(file.type) || fileExt(file.name) || "png";
      const buffer = await file.arrayBuffer();
      await this.addQuiltTile(new Uint8Array(buffer), ext, file.name || `image.${ext}`);
    } catch (e) {
      console.error("tufte-figures: failed to read quilt image", e);
      new Notice("Tufte Figures: couldn't read the image.");
    }
  }

  async addQuiltTileFromTFile(tfile) {
    try {
      const buffer = await this.app.vault.readBinary(tfile);
      const ext = tfile.extension || "png";
      await this.addQuiltTile(new Uint8Array(buffer), ext, tfile.name);
    } catch (e) {
      console.error("tufte-figures: failed to read vault image", e);
    }
  }

  // Load an image's bytes into a tile (object URL + natural ratio), then
  // re-render the stage. Resolves once the tile is added.
  addQuiltTile(bytes, ext, name) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeFromExt(ext) }));
      this._objectUrls.push(url);
      const tile = { bytes, ext, name, ratio: 1, url, imgEl: null };
      const img = new Image();
      const done = () => {
        tile.imgEl = img;
        if (img.naturalWidth && img.naturalHeight) {
          tile.ratio = img.naturalWidth / img.naturalHeight;
        }
        this.quilt.tiles.push(tile);
        this.renderQuiltStage();
        resolve();
      };
      img.onload = done;
      img.onerror = done;
      img.src = url;
    });
  }

  quiltStageWidth() {
    const w = this.quiltStageEl && this.quiltStageEl.clientWidth;
    return w && w > 20 ? w : 480;
  }

  renderQuiltStage() {
    const stage = this.quiltStageEl;
    if (!stage) return;
    stage.empty();

    if (this.quilt.loading) {
      stage.createDiv({ cls: "tufte-quilt-empty", text: "Loading quilt…" });
      return;
    }
    if (!this.quilt.tiles.length) {
      stage.createDiv({
        cls: "tufte-quilt-empty",
        text: "No images yet — drop some below to build the quilt."
      });
      return;
    }

    const h = this.quilt.rowHeight;
    const scale = this.quilt.zoom / 100;
    this.quilt.tiles.forEach((tile, i) => {
      const cell = stage.createDiv({ cls: "tufte-quilt-tile" });
      cell.style.height = `${h}px`;
      cell.style.width = `${Math.max(1, Math.round(h * (tile.ratio || 1)))}px`;
      cell.dataset.index = String(i);

      const img = cell.createEl("img");
      img.src = tile.url;
      img.draggable = false;
      img.style.transform = `scale(${scale})`;
      img.style.filter = this.quilt.grayscale ? "grayscale(1)" : "";

      const rm = cell.createEl("button", { text: "✕", cls: "tufte-quilt-tile-remove" });
      rm.onclick = (e) => {
        e.stopPropagation();
        const at = Number(cell.dataset.index);
        this.quilt.tiles.splice(at, 1);
        this.renderQuiltStage();
      };

      this.attachQuiltDrag(cell);
    });
  }

  // Pointer-based drag-to-reorder (works on desktop and touch). On crossing
  // into another tile, the dragged tile is spliced to that index and the stage
  // re-renders live.
  attachQuiltDrag(cell) {
    cell.addEventListener("pointerdown", (e) => {
      if (e.target instanceof HTMLElement && e.target.closest(".tufte-quilt-tile-remove")) {
        return;
      }
      e.preventDefault();
      const tiles = this.quilt.tiles;
      let from = Number(cell.dataset.index);
      cell.classList.add("is-dragging");

      const onMove = (ev) => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const overCell = el && el.closest && el.closest(".tufte-quilt-tile");
        if (!overCell) return;
        const to = Number(overCell.dataset.index);
        if (!Number.isInteger(to) || to === from) return;
        const [moved] = tiles.splice(from, 1);
        tiles.splice(to, 0, moved);
        from = to;
        this.renderQuiltStage();
        const fresh = this.quiltStageEl.querySelector(
          `.tufte-quilt-tile[data-index="${to}"]`
        );
        if (fresh) fresh.classList.add("is-dragging");
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        this.renderQuiltStage();
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  }

  // Render the arranged tiles to a transparent-background PNG. The layout uses
  // the same maxWidth as the live stage so the export matches what the user
  // arranged; the canvas is up-scaled for crispness while drawing from the
  // full-resolution source images.
  renderQuiltCanvas() {
    const tiles = this.quilt.tiles.filter((t) => t.imgEl);
    if (!tiles.length) return Promise.resolve(null);
    const h = this.quilt.rowHeight;
    const { width, height, placements } = layoutQuilt(tiles, h, this.quiltStageWidth());
    if (!width || !height) return Promise.resolve(null);
    const exportScale = Math.max(2, Math.min(6, 2000 / width));

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * exportScale));
    canvas.height = Math.max(1, Math.round(height * exportScale));
    const ctx = canvas.getContext("2d");
    ctx.scale(exportScale, exportScale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (this.quilt.grayscale && "filter" in ctx) ctx.filter = "grayscale(100%)";

    const z = this.quilt.zoom / 100;
    for (const p of placements) {
      const img = p.tile.imgEl;
      const nw = img.naturalWidth || 1;
      const nh = img.naturalHeight || 1;
      const sw = nw / z;
      const sh = nh / z;
      const sx = (nw - sw) / 2;
      const sy = (nh - sh) / 2;
      try {
        ctx.drawImage(img, sx, sy, sw, sh, p.x, p.y, p.w, p.h);
      } catch (e) {
        console.error("tufte-figures: failed to draw quilt tile", e);
      }
    }

    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  }

  async doInsertQuilt() {
    if (!this.quilt.tiles.length) {
      new Notice("Tufte Figures: add at least one image to the quilt.");
      return;
    }
    if (this.quilt.tiles.some((t) => !t.imgEl)) {
      new Notice("Tufte Figures: images still loading — try again in a moment.");
      return;
    }
    try {
      const adapter = this.app.vault.adapter;
      const id = this.quilt.id || String(Date.now());
      const dir = quiltDir(this.app, id);
      await ensureFolder(adapter, `${dir}/src`);

      // Persist the source tiles (hidden under .obsidian/) and the config list.
      const cfgTiles = [];
      for (let i = 0; i < this.quilt.tiles.length; i++) {
        const tile = this.quilt.tiles[i];
        const rel = `src/${i}.${tile.ext || "png"}`;
        await adapter.writeBinary(`${dir}/${rel}`, toArrayBuffer(tile.bytes));
        cfgTiles.push({ file: rel, ratio: tile.ratio || 1, name: tile.name || rel });
      }

      // Render the quilt PNG.
      const blob = await this.renderQuiltCanvas();
      if (!blob) {
        new Notice("Tufte Figures: couldn't render the quilt.");
        return;
      }
      const pngBuf = await blob.arrayBuffer();

      // Margin mode isn't offered for quilts; fall back to default if inherited.
      const mode = this.mode === "margin" ? "default" : this.mode;

      // Save (first time) or overwrite (re-edit) the visible PNG in the vault.
      let pngPath = this.quilt.pngPath;
      let tfile = pngPath ? this.app.vault.getAbstractFileByPath(pngPath) : null;
      if (tfile) {
        await this.app.vault.modifyBinary(tfile, pngBuf);
      } else {
        // Generated quilts go to a user-configurable folder (default img/quilt).
        const folder = normalizeQuiltFolder(this.plugin.settings.quiltFolder);
        if (folder) await ensureFolder(this.app.vault.adapter, folder);
        pngPath = folder ? `${folder}/quilt-${id}.png` : `quilt-${id}.png`;
        tfile = await this.app.vault.createBinary(pngPath, pngBuf);
      }
      this.quilt.id = id;
      this.quilt.dir = dir;
      this.quilt.pngPath = pngPath;

      // Write the re-editable config sidecar.
      const config = {
        version: 1,
        id,
        pngPath,
        rowHeight: this.quilt.rowHeight,
        zoom: this.quilt.zoom,
        grayscale: this.quilt.grayscale,
        mode,
        number: this.number || "1",
        caption: this.caption || "",
        tiles: cfgTiles
      };
      await adapter.write(`${dir}/config.json`, JSON.stringify(config, null, 2));

      // Hand off to the ordinary figure pipeline (caption, number, anchor,
      // reference, click-to-enlarge, the three modes — all reused).
      const embed = this.plugin.buildEmbed(tfile, this.sourcePath);
      const block = buildFigureBlock(mode, {
        embed,
        // Alt stays empty like every other insertion path — a `|alt`
        // segment renders as a grey caption box under the figure.
        alt: "",
        caption: (this.caption || "").trim(),
        number: this.number || "1",
        labelPrefix: this.plugin.settings.labelPrefix
      });
      this.commitBlock(block);
      new Notice(this.isEdit ? "Quilt updated" : "Quilt inserted");
      this.close();
    } catch (e) {
      console.error("tufte-figures: failed to generate quilt", e);
      new Notice("Tufte Figures: couldn't generate the quilt.");
    }
  }

  async loadQuiltFromConfig() {
    const opt = this.opts.quilt;
    if (!opt) return;
    const adapter = this.app.vault.adapter;
    const dir = opt.dir;
    this.quilt.loading = true;
    this.renderQuiltStage();
    try {
      const cfg = JSON.parse(await adapter.read(`${dir}/config.json`));
      this.quilt.id = cfg.id || opt.id;
      this.quilt.dir = dir;
      this.quilt.pngPath = cfg.pngPath || this.quilt.pngPath;
      this.quilt.rowHeight = cfg.rowHeight || 150;
      this.quilt.zoom = cfg.zoom || 100;
      this.quilt.grayscale = !!cfg.grayscale;
      if (cfg.mode) this.mode = cfg.mode;
      if (cfg.number) this.number = String(cfg.number);
      if (typeof cfg.caption === "string") this.caption = cfg.caption;

      const tiles = [];
      for (const ct of cfg.tiles || []) {
        try {
          const bytes = new Uint8Array(await adapter.readBinary(`${dir}/${ct.file}`));
          const ext = (ct.file.split(".").pop() || "png").toLowerCase();
          const url = URL.createObjectURL(new Blob([bytes], { type: mimeFromExt(ext) }));
          this._objectUrls.push(url);
          const tile = {
            bytes,
            ext,
            name: ct.name || ct.file,
            ratio: ct.ratio || 1,
            url,
            imgEl: null
          };
          await new Promise((res) => {
            const img = new Image();
            const done = () => {
              tile.imgEl = img;
              if (img.naturalWidth && img.naturalHeight) {
                tile.ratio = img.naturalWidth / img.naturalHeight;
              }
              res();
            };
            img.onload = done;
            img.onerror = done;
            img.src = url;
          });
          tiles.push(tile);
        } catch (e) {
          console.error("tufte-figures: failed to load quilt tile", ct, e);
        }
      }
      this.quilt.tiles = tiles;
    } catch (e) {
      console.error("tufte-figures: failed to load quilt config", e);
      new Notice("Tufte Figures: couldn't load the saved quilt.");
    } finally {
      this.quilt.loading = false;
      // Sync widgets that were built before the async config arrived.
      this._quiltRowSlider?.setValue(this.quilt.rowHeight);
      this._quiltZoomSlider?.setValue(this.quilt.zoom);
      this._quiltGrayToggle?.setValue(this.quilt.grayscale);
      this.renderQuiltStage();
    }
  }

  indicatorText() {
    return figureReferenceText(this.number || "N");
  }

  updateIndicator() {
    if (this.indicatorInput) this.indicatorInput.setValue(this.indicatorText());
  }

  onWidthChanged(v) {
    this.width = (v || "").trim();
    if (!this.width) {
      this.height = "";
      this.heightInput?.setValue("");
    } else if (this.ratio) {
      this.height = String(Math.round(parseInt(this.width, 10) / this.ratio));
      this.heightInput?.setValue(this.height);
    }
  }

  onHeightChanged(v) {
    this.height = (v || "").trim();
    if (!this.height) {
      this.width = "";
      this.widthInput?.setValue("");
    } else if (this.ratio) {
      this.width = String(Math.round(parseInt(this.height, 10) * this.ratio));
      this.widthInput?.setValue(this.width);
    }
  }

  // Load the image so we can lock the width/height ratio and show its
  // natural dimensions as placeholders. Degrades gracefully (independent
  // fields) when the source can't be resolved.
  resolveNaturalSize() {
    const parsed = parseEmbed(this.embed);
    let src = "";
    if (parsed.kind === "wiki") {
      const linkpath = (parsed.path || "").split("#")[0];
      const tfile = this.app.metadataCache.getFirstLinkpathDest(
        linkpath,
        this.sourcePath
      );
      if (tfile) {
        try {
          src = this.app.vault.getResourcePath(tfile);
        } catch {}
      }
    } else if (parsed.kind === "md") {
      src = parsed.path;
    }
    if (!src) {
      this.ratio = null;
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth && img.naturalHeight) {
        this.ratio = img.naturalWidth / img.naturalHeight;
        this.applyNaturalPlaceholders(img.naturalWidth, img.naturalHeight);
      }
    };
    img.onerror = () => {
      this.ratio = null;
    };
    img.src = src;
  }

  applyNaturalPlaceholders(w, h) {
    this.widthInput?.setPlaceholder(String(w));
    this.heightInput?.setPlaceholder(String(h));
    // Keep the pre-filled pair consistent when an embed carried only one axis.
    if (this.ratio && this.width && !this.height) {
      this.height = String(Math.round(parseInt(this.width, 10) / this.ratio));
      this.heightInput?.setValue(this.height);
    } else if (this.ratio && this.height && !this.width) {
      this.width = String(Math.round(parseInt(this.height, 10) * this.ratio));
      this.widthInput?.setValue(this.width);
    }
  }

  doInsert() {
    if (!this.embed || !this.embed.trim()) {
      new Notice("Tufte Figures: the image link is empty.");
      return;
    }
    // Ratio locked → encode width only (height stays auto, preserving the
    // ratio). No ratio (e.g. external image) → encode both axes as typed.
    const width = this.width || "";
    const height = this.ratio ? "" : this.height || "";
    const block = buildFigureBlock(this.mode, {
      embed: this.embed.trim(),
      alt: this.alt,
      caption: this.caption.trim(),
      number: this.number || "1",
      labelPrefix: this.plugin.settings.labelPrefix,
      width,
      height
    });
    this.commitBlock(block);
    this.close();
  }

  // Replace the original figure block when editing; otherwise insert anew.
  commitBlock(block) {
    const range = this.opts.editRange;
    if (range) {
      const to = Math.min(range.to, this.editor.lineCount() - 1);
      const endCh = (this.editor.getLine(to) || "").length;
      this.editor.replaceRange(block, { line: range.from, ch: 0 }, { line: to, ch: endCh });
      this.editor.focus?.();
      return;
    }
    insertBlockAtPos(this.editor, block, this.opts.pos);
  }

  onClose() {
    for (const url of this._objectUrls || []) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
    this._objectUrls = [];
    this.contentEl.empty();
  }
}

// --- settings ------------------------------------------------------------

class FigureSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Intercept image drops and pastes")
      .setDesc(
        "When on, dragging or pasting an image into the editor opens the figure modal. Turn off to use plain Obsidian embedding and the 'Insert figure' command only."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.interceptDrops).onChange(async (v) => {
          this.plugin.settings.interceptDrops = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Figure label prefix")
      .setDesc(
        "Prefix shown before the number in margin-figure captions, e.g. 'Fig.' → 'Fig. 1.'"
      )
      .addText((t) =>
        t.setValue(this.plugin.settings.labelPrefix).onChange(async (v) => {
          this.plugin.settings.labelPrefix = v || "Fig.";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Image quilt output folder")
      .setDesc(
        "Vault-relative folder where generated image-quilt PNGs are saved (created if missing). Leave blank for the vault root. Default: img/quilt."
      )
      .addText((t) =>
        t
          .setPlaceholder("img/quilt")
          .setValue(this.plugin.settings.quiltFolder)
          .onChange(async (v) => {
            this.plugin.settings.quiltFolder = normalizeQuiltFolder(v);
            await this.plugin.saveSettings();
          })
      );
  }
}
