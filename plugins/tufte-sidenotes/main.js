const { MarkdownRenderer, Plugin, TFile } = require("obsidian");

// New recommended syntax:
//   > [!sidenote] 1
//   > body text
// Obsidian renders the "1" into `.callout-title-inner` itself, so the
// label is in the DOM from the moment the widget mounts — no plugin
// write, no flicker, no chance of a wrong number flashing through.
//
// Legacy syntax stays supported:
//   > [!sidenote]
//   > [^N]: body text
// For legacy, the plugin rewrites the auto-fallback title to N and (in
// Reading view) hydrates the body from the footnote definition.
//
// The editor/CodeMirror surface intentionally stays single-column:
// sidenotes and marginnotes are ordinary callouts there. Marginalia
// rendering is reserved for Reading view so the source stays easy to edit.

const SIDENOTE_START_RE = /^\s*>\s*\[!sidenote\][+-]?(?:\s+(.*))?$/i;
const BLOCKQUOTE_LINE_RE = /^\s*>\s?(.*)$/;
const FOOTNOTE_DEF_RE = /^\s*\[\^([^\]]+)\]:\s?(.*)$/;
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g;
const FENCE_RE = /^\s*(```|~~~)/;
const AUTO_TITLE_RE = /^sidenote$/i;
const ENABLED_CLASS = "tufte-sidenotes-enabled";
const MARGINNOTE_REVEALED_CLASS = "tufte-marginnote-revealed";
// Mirror the stylesheet's `@container tufte-pane (max-width: 760px)` collapse
// breakpoint. The CSS hides the marginalia and turns the markers into toggles
// at this pane width; the tap handler must agree about when that's in effect.
const COLLAPSE_BREAKPOINT_PX = 760;

module.exports = class TufteSidenotesPlugin extends Plugin {
  async onload() {
    this.pendingHydrates = new WeakMap();
    this.refreshScheduled = false;
    this.syncEnabledClass();
    this.register(() => {
      document.body?.classList.remove(ENABLED_CLASS);
      document.documentElement?.classList.remove(ENABLED_CLASS);
    });

    this.registerMarkdownPostProcessor((el, ctx) => {
      // Synchronous work first: inline `[^N]` markers in prose. Doing
      // this in the postprocessor body — not a deferred RAF — means the
      // wrapped <sup> is in place before Obsidian hands the section
      // back to its renderer, so it always paints with the styling.
      if (this.syncEnabledClass() && isReadingViewContent(el)) {
        labelReadingViewInlineRefsFromBrackets(el);
        wrapLiteralFootnoteRefsAsSup(el);
        // Obsidian's renderer silently strips `[^N]` (no matching
        // `[^N]:` definition) to bare lowercased text — no <sup>, no
        // class — leaving CSS nothing to target. Use the section's
        // source markdown to find each ref's position and wrap the
        // corresponding stripped text into a <sup class="tufte-sidenote-ref">.
        const sectionInfo = getSectionInfo(ctx, el);
        if (sectionInfo?.text) {
          wrapStrippedFootnoteRefsFromSource(el, sectionInfo.text);
        } else {
          this.queueStrippedWrap(el, ctx);
        }
        // Defer legacy [^N]:-body callout hydration: it needs an async
        // source read and a render-markdown round-trip.
        this.queueHydrate(el, ctx);
      }
    });

    this.registerLivePreviewObserver();
    this.registerCollapsedNoteReveal();
    this.registerMarginaliaCommands();
  }

  registerMarginaliaCommands() {
    this.addCommand({
      id: "insert-sidenote",
      name: "Insert sidenote at cursor",
      editorCallback: (editor) => insertSidenoteAtCursor(editor)
    });
    this.addCommand({
      id: "insert-marginnote",
      name: "Insert marginnote after paragraph",
      editorCallback: (editor) => insertMarginnoteAtCursor(editor)
    });
    this.addCommand({
      id: "insert-epigraph",
      name: "Insert epigraph after paragraph",
      editorCallback: (editor) => insertEpigraphAtCursor(editor)
    });
  }

  syncEnabledClass() {
    const enabled = this.isTufteThemeActive();
    document.body?.classList.toggle(ENABLED_CLASS, enabled);
    document.documentElement?.classList.toggle(ENABLED_CLASS, enabled);
    return enabled;
  }

  registerCollapsedNoteReveal() {
    // When the PANE is narrow (≤760px — sidebars open, a split, or a real
    // phone), sidenote callouts are hidden by the stylesheet's
    // `@container tufte-pane (max-width: 760px)` rule, exactly like tufte-css
    // on a small screen. Clicking the matching `[^N]` marker — the numeric
    // superscript, which we deliberately keep visible — toggles
    // `tufte-sidenote-revealed` on the callout so it drops into the flow next
    // to its caller. Clicking the revealed callout (or its number again)
    // dismisses it.
    //
    // Marginnotes have no number, so they collapse to a ⊕ glyph (the callout
    // title) that toggles the body, following tufte-css's marginnote toggle.
    //
    // The handler runs in the CAPTURE phase so it can intercept the
    // click before CodeMirror moves the cursor into the callout source.
    const handler = (event) => {
      if (!this.syncEnabledClass()) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".markdown-source-view.mod-cm6")) return;
      if (!isCollapsedPane(target)) return;

      const marginnoteTitle = target.closest(
        '.markdown-preview-view .callout[data-callout="marginnote"] .callout-title'
      );
      if (marginnoteTitle) {
        const marginnote = marginnoteTitle.closest(
          '.callout[data-callout="marginnote"]'
        );
        if (marginnote) {
          toggleMarginnote(marginnote);
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      // Tapped a revealed sidenote itself → dismiss it.
      const revealedCallout = target.closest(
        '.callout[data-callout="sidenote"].tufte-sidenote-revealed'
      );
      if (revealedCallout) {
        revealedCallout.classList.remove("tufte-sidenote-revealed");
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // Tapped an inline marker → toggle the matching sidenote.
      const marker = target.closest(
        ".markdown-preview-view sup.tufte-sidenote-ref, .markdown-preview-view sup.footnote-ref"
      );
      if (!marker) return;

      const label = readMarkerLabel(marker);
      if (!label) return;

      const view = marker.closest(".markdown-preview-view");
      if (!view) return;

      const callouts = Array.from(
        view.querySelectorAll('.callout[data-callout="sidenote"]')
      );
      const match = callouts.find((callout) => {
        const title = callout
          .querySelector(".callout-title-inner")
          ?.textContent?.trim();
        return title && title === label;
      });
      if (!match) return;

      // Hide any other open sidenotes in the same view so only one is
      // revealed at a time — keeps the flow scannable on a small screen.
      for (const other of callouts) {
        if (other !== match) other.classList.remove("tufte-sidenote-revealed");
      }
      match.classList.toggle("tufte-sidenote-revealed");

      // Scroll the freshly-revealed note into view. Skip on dismiss.
      if (match.classList.contains("tufte-sidenote-revealed")) {
        match.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }

      event.preventDefault();
      event.stopPropagation();
    };

    // Capture phase so we beat CodeMirror's own click handler.
    this.registerDomEvent(document, "click", handler, { capture: true });

    const keyHandler = (event) => {
      if (!this.syncEnabledClass()) return;
      if (event.key !== "Enter" && event.key !== " ") return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".markdown-source-view.mod-cm6")) return;
      if (!isCollapsedPane(target)) return;
      const marginnoteTitle = target.closest(
        '.markdown-preview-view .callout[data-callout="marginnote"] .callout-title'
      );
      if (!marginnoteTitle) return;

      const marginnote = marginnoteTitle.closest(
        '.callout[data-callout="marginnote"]'
      );
      if (!marginnote) return;

      toggleMarginnote(marginnote);
      event.preventDefault();
      event.stopPropagation();
    };
    this.registerDomEvent(document, "keydown", keyHandler, { capture: true });
  }

  registerLivePreviewObserver() {
    const refresh = () => this.scheduleRefresh();
    // childList only — attribute changes (the plugin's own dataset writes,
    // cursor blink class toggles) and characterData (live word counts) would
    // otherwise re-enter and amplify any flicker.
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true });

    const themeObserver = new MutationObserver(refresh);
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style"]
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"]
    });

    this.register(() => {
      observer.disconnect();
      themeObserver.disconnect();
    });
    this.registerEvent(this.app.workspace.on("file-open", refresh));
    this.registerEvent(this.app.workspace.on("active-leaf-change", refresh));
    this.registerEvent(this.app.workspace.on("layout-change", refresh));
    refresh();
  }

  scheduleRefresh() {
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    window.requestAnimationFrame(() => {
      this.refreshScheduled = false;
      this.refreshLivePreview();
    });
  }

  refreshLivePreview() {
    if (!this.syncEnabledClass()) return;

    document.querySelectorAll(".markdown-preview-view").forEach((root) => {
      // Title-based labelling for every visible sidenote callout. New
      // syntax callouts already have the right title — we just clear the
      // "untitled" class if it was set on a previous pass. Legacy callouts
      // need their auto-fallback title rewritten to the [^N]:-derived label.
      root
        .querySelectorAll('.callout[data-callout="sidenote"]')
        .forEach((callout) => ensureSidenoteTitleLabel(callout));

      root
        .querySelectorAll('.callout[data-callout="marginnote"]')
        .forEach((callout) => ensureMarginnoteToggle(callout));

      // Reading view: wrap any literal [^N] markers and relabel existing
      // `sup.footnote-ref` nodes. The markdown postprocessor handles this
      // too on desktop, but Obsidian Mobile occasionally renders sections
      // without firing the postprocessor for our plugin in time — running
      // it from the observer as well is harmless (idempotent) and rescues
      // those cases. The walker skips already-wrapped elements.
      labelReadingViewInlineRefsFromBrackets(root);
      wrapLiteralFootnoteRefsAsSup(root);
    });

    // Stripped-ref wrap needs the source markdown (Obsidian's renderer
    // drops `[^N]` chars from the DOM). Per markdown leaf, read the
    // current source via the view, then wrap. This is what catches
    // file switches and re-renders that the per-section postprocessor
    // missed — the postprocessor only fires for *new* sections, so
    // anything Obsidian served from cache stays unwrapped without this
    // observer-side pass.
    const leaves = this.app.workspace.getLeavesOfType?.("markdown") || [];
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!view) continue;
      const root = view.containerEl?.querySelector(".markdown-preview-view");
      if (!root) continue;
      let source = "";
      try {
        if (typeof view.getViewData === "function") {
          source = view.getViewData() || "";
        }
      } catch {}
      if (source) {
        wrapStrippedFootnoteRefsFromSource(root, source);
      }
    }
  }

  queueHydrate(el, ctx) {
    const win = el.ownerDocument?.defaultView || window;
    const sectionInfo = getSectionInfo(ctx, el);
    const sourcePath = ctx.sourcePath;
    const ticket = Symbol(sourcePath);

    this.pendingHydrates.set(el, ticket);
    win.requestAnimationFrame(() => {
      if (this.pendingHydrates.get(el) === ticket) {
        this.hydrate(el, sourcePath, ticket, sectionInfo);
      }
    });
  }

  async queueStrippedWrap(el, ctx) {
    // Async fallback when ctx.getSectionInfo(el).text isn't available.
    // Read the source file, slice the section's line range, and wrap.
    const sectionInfo = getSectionInfo(ctx, el);
    if (!sectionInfo || !ctx.sourcePath) return;
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile)) return;
    const source = await this.app.vault.cachedRead(file);
    const sectionSource = getSectionSource(source, sectionInfo);
    if (sectionSource) {
      wrapStrippedFootnoteRefsFromSource(el, sectionSource);
    }
  }

  async hydrate(root, sourcePath, ticket, sectionInfo) {
    if (!this.syncEnabledClass()) return;

    // Inline-ref wrapping/relabelling already happened synchronously in
    // the postprocessor body. This deferred phase only handles legacy
    // `[^N]:`-body callouts that need an async source read.

    const callouts = Array.from(
      root.querySelectorAll('.callout[data-callout="sidenote"]')
    );
    if (!callouts.length) {
      removeFootnoteTail(root);
      removeFootnoteTail(getDocumentRoot(root));
      return;
    }

    // For each callout, first try to read the new-syntax title. If the
    // title is the auto-fallback "Sidenote", we're looking at the legacy
    // syntax and need to hydrate the body from source.
    let source = null;
    let legacySidenotes = null;

    for (const callout of callouts) {
      const titleLabel = readExplicitTitleLabel(callout);
      if (titleLabel != null) {
        // New syntax: the title is the label and the body is whatever
        // Obsidian already rendered. Nothing to do.
        callout.classList.remove("tufte-sidenote-untitled");
        callout.dataset.tufteFootnoteId = titleLabel;
        continue;
      }

      // Legacy syntax — need source to find the [^N]: body for this
      // callout. Read it once per hydrate call.
      if (source === null) {
        const file = this.app.vault.getAbstractFileByPath(sourcePath);
        if (!(file instanceof TFile)) break;
        source = await this.app.vault.cachedRead(file);
        if (this.pendingHydrates.get(root) !== ticket) return;
      }
      if (legacySidenotes === null) {
        const refs = parseFootnoteReferences(source);
        legacySidenotes = parseSidenoteDefinitions(source, refs).filter(Boolean);
      }

      const sectionSource = getSectionSource(source, sectionInfo);
      const localSidenotes = sectionSource
        ? parseSidenoteDefinitions(
            sectionSource,
            parseFootnoteReferences(source)
          ).filter(Boolean)
        : filterSidenotesBySection(legacySidenotes, sectionInfo);

      // Match this callout to a legacy sidenote: prefer the section-local
      // list (DOM order = source order inside one rendered section), fall
      // back to text-content match against the full list.
      const sidenote =
        localSidenotes[callouts.indexOf(callout) % localSidenotes.length] ||
        findLegacySidenoteByText(callout, legacySidenotes);
      if (!sidenote) {
        callout.classList.add("tufte-sidenote-untitled");
        continue;
      }
      callout.classList.remove("tufte-sidenote-untitled");
      await this.hydrateLegacyCallout(callout, sidenote, sourcePath);
    }

    removeFootnoteTail(root);
    removeFootnoteTail(getDocumentRoot(root));
  }

  isTufteThemeActive() {
    // Desktop: vault config exposes the active CSS theme name.
    try {
      if (this.app.vault.getConfig?.("cssTheme") === "Tufte") return true;
    } catch {}
    // Mobile / fallback: vault.getConfig may be unavailable. Detect the
    // theme by probing for a CSS variable it defines (--tufte-accent).
    // Try every plausible anchor — body, documentElement, and the
    // active markdown view — because Obsidian's mobile build sometimes
    // sets the theme classes on `<html>` rather than `<body>`.
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

  async hydrateLegacyCallout(callout, sidenote, sourcePath) {
    const content = callout.querySelector(".callout-content");
    if (!content) return;

    const signature = hashText(
      `${sidenote.id}\n${sidenote.label}\n${sidenote.markdown}`
    );
    if (
      callout.dataset.tufteSidenoteHash === signature &&
      callout.dataset.tufteFootnoteId === sidenote.id
    ) {
      // Already rendered with the same source — but the title may have
      // been re-mounted, so re-stamp that.
      writeTitleLabel(callout, sidenote.label);
      return;
    }

    callout.dataset.tufteFootnoteId = sidenote.id;
    callout.dataset.tufteSidenoteHash = signature;

    while (content.firstChild) content.removeChild(content.firstChild);
    await renderMarkdown(this.app, sidenote.markdown, content, sourcePath, this);
    writeTitleLabel(callout, sidenote.label);
  }
};

function isReadingViewContent(el) {
  if (!el?.closest) return false;
  if (el.closest(".markdown-source-view.mod-cm6")) return false;
  return Boolean(el.closest(".markdown-preview-view"));
}

function isCollapsedPane(el) {
  // Marginalia collapse is driven by the stylesheet's
  // `@container tufte-pane (max-width: 760px)` rule, which measures the
  // reading-view PANE — not the window. Mirror that here so clicks toggle
  // exactly when the CSS has collapsed the notes (e.g. a narrow pane inside a
  // wide window with the sidebars open). `.markdown-reading-view` is the
  // theme's `tufte-pane` container; its clientWidth is the content-box inline
  // size the container query compares against.
  const pane = el?.closest?.(".markdown-reading-view");
  if (!pane) return false;
  return pane.clientWidth <= COLLAPSE_BREAKPOINT_PX;
}

function readMarkerLabel(marker) {
  // Trust an explicit label first; older plugin versions and some DOM
  // shapes may still expose one.
  if (marker.dataset?.tufteLabel) return marker.dataset.tufteLabel.trim();

  const text = (marker.textContent || "").trim();

  // Literal [^N] text — strip the caret-bracket.
  const bracketedWithCaret = extractBracketedFootnoteRefLabel(text);
  if (bracketedWithCaret) return bracketedWithCaret;

  // Plain [N] (some Obsidian skins render sup.footnote-ref this way).
  const bracketedPlain = text.match(/^\[(.+)\]$/);
  if (bracketedPlain) return bracketedPlain[1].trim();

  // Legacy DOM (sup.footnote-ref > a.footnote-link): the anchor inside
  // carries the visible label.
  const link = marker.querySelector?.("a.footnote-link");
  if (link) return (link.textContent || "").trim();

  return text || null;
}

function ensureSidenoteTitleLabel(callout) {
  const titleInner = callout.querySelector(".callout-title-inner");
  if (!titleInner) return;

  const currentText = (titleInner.textContent || "").trim();

  if (currentText && !AUTO_TITLE_RE.test(currentText)) {
    // New-syntax callout: Obsidian rendered the user's title verbatim.
    // Nothing to write, just clear the untitled flag if it lingers.
    if (callout.classList.contains("tufte-sidenote-untitled")) {
      callout.classList.remove("tufte-sidenote-untitled");
    }
    if (callout.dataset.tufteFootnoteId !== currentText) {
      callout.dataset.tufteFootnoteId = currentText;
    }
    return;
  }

  // Legacy / unlabelled: look for `[^N]:` in the body and use N.
  const content = callout.querySelector(".callout-content");
  const legacyId = extractFootnoteIdFromText(content?.textContent || "");
  if (legacyId) {
    writeTitleLabel(callout, legacyId);
    return;
  }

  // No recoverable label — collapse the title block.
  if (!callout.classList.contains("tufte-sidenote-untitled")) {
    callout.classList.add("tufte-sidenote-untitled");
  }
}

function readExplicitTitleLabel(callout) {
  const titleInner = callout.querySelector(".callout-title-inner");
  if (!titleInner) return null;
  const text = (titleInner.textContent || "").trim();
  if (!text || AUTO_TITLE_RE.test(text)) return null;
  return text;
}

function writeTitleLabel(callout, label) {
  if (!callout) return;
  const titleInner = callout.querySelector(".callout-title-inner");
  if (titleInner && titleInner.textContent !== label) {
    titleInner.textContent = label;
  }
  if (callout.classList.contains("tufte-sidenote-untitled")) {
    callout.classList.remove("tufte-sidenote-untitled");
  }
  if (callout.dataset.tufteFootnoteId !== label) {
    callout.dataset.tufteFootnoteId = label;
  }
}

function ensureMarginnoteToggle(callout) {
  const title = callout.querySelector(".callout-title");
  if (!title) return;

  title.setAttribute("role", "button");
  title.setAttribute("tabindex", "0");
  title.setAttribute("aria-label", "Toggle margin note");
  title.setAttribute(
    "aria-expanded",
    callout.classList.contains(MARGINNOTE_REVEALED_CLASS) ? "true" : "false"
  );
}

function toggleMarginnote(callout) {
  const expanded = !callout.classList.contains(MARGINNOTE_REVEALED_CLASS);
  callout.classList.toggle(MARGINNOTE_REVEALED_CLASS, expanded);
  ensureMarginnoteToggle(callout);
}

// --- inline marker handling ---------------------------------------------

function labelReadingViewInlineRefsFromBrackets(root) {
  root.querySelectorAll("sup.footnote-ref > a.footnote-link").forEach((link) => {
    // The href Obsidian writes encodes the source label after `fn-`,
    // e.g. <a href="#fn-1-..."> or <a href="#fn-demo-...">.
    const label =
      labelFromHref(link.getAttribute("href")) ||
      labelFromHref(link.id) ||
      extractVisibleFootnoteLabel(link);
    if (!label) return;
    if (link.textContent !== label) {
      link.textContent = label;
    }
    const aria = `Sidenote ${label}`;
    if (link.getAttribute("aria-label") !== aria) {
      link.setAttribute("aria-label", aria);
    }
  });
}

function wrapStrippedFootnoteRefsFromSource(root, sectionSource) {
  // Obsidian's renderer drops `[^N]` when no `[^N]:` definition exists,
  // emitting the label as bare lowercased text concatenated into the
  // surrounding paragraph. To restore a styleable marker we have to use
  // the *source* markdown (where `[^N]` is still intact) to find each
  // ref's location, then locate the corresponding stripped label in the
  // rendered DOM and wrap it in <sup class="tufte-sidenote-ref">N</sup>.
  if (!sectionSource) return;

  try {
    // Skip refs inside fenced code blocks — those are documentation of
    // the syntax, not actual references. The same code-fence tracking
    // the legacy `parseSidenoteDefinitions` uses.
    const lines = sectionSource.split(/\r?\n/);
    let inFence = false;
    const lineStartIdx = [];
    let cursor = 0;
    for (let i = 0; i < lines.length; i++) {
      lineStartIdx[i] = cursor;
      cursor += lines[i].length + 1; // +1 for the \n that was removed
    }
    const fencedRanges = [];
    let fenceStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (FENCE_RE.test(lines[i])) {
        if (inFence) {
          fencedRanges.push([fenceStart, lineStartIdx[i] + lines[i].length]);
          inFence = false;
        } else {
          fenceStart = lineStartIdx[i];
          inFence = true;
        }
      }
    }
    const isInFence = (idx) =>
      fencedRanges.some(([s, e]) => idx >= s && idx < e);

    const refRe = /\[\^([^\]\s]+)\]/g;
    const refs = [];
    let m;
    while ((m = refRe.exec(sectionSource))) {
      // Skip definitions (`[^N]:`).
      if (sectionSource[m.index + m[0].length] === ":") continue;
      // Skip refs inside fenced code blocks.
      if (isInFence(m.index)) continue;
      // Skip refs inside inline code spans on the same line. Walk
      // backtick runs: each *run* of one or more backticks toggles the
      // in-code state. (The old per-character toggle missed the case
      // where `[^N]` followed a closing backtick at the end of the
      // scan window, leaving state stuck as "in code".)
      const lineStart = sectionSource.lastIndexOf("\n", m.index) + 1;
      const lineEnd = sectionSource.indexOf("\n", m.index);
      const line = sectionSource.slice(
        lineStart,
        lineEnd === -1 ? sectionSource.length : lineEnd
      );
      const offsetInLine = m.index - lineStart;
      let inInlineCode = false;
      let i = 0;
      while (i < offsetInLine) {
        if (line[i] === "`") {
          while (i < offsetInLine && line[i] === "`") i++;
          inInlineCode = !inInlineCode;
        } else {
          i++;
        }
      }
      if (inInlineCode) continue;

      refs.push({ label: m[1], sourceIndex: m.index });
    }
    if (!refs.length) return;

    for (const ref of refs) {
      wrapOneStrippedRef(root, ref, sectionSource);
    }
  } catch (e) {
    // Never let a wrap error break the rendered page.
    console.error("tufte-sidenotes: wrapStrippedFootnoteRefsFromSource", e);
  }
}

function wrapOneStrippedRef(root, ref, sectionSource) {
  // Build a prefix from the ~30 source chars before `[^N]`. Strip the
  // markdown that becomes its own DOM element in the rendered output:
  //   - whole inline-code spans `…`     (Obsidian wraps in <code>, which
  //                                       the walker skips entirely)
  //   - link syntax [text](url)         (we keep the text, drop the URL)
  //   - emphasis chars * and _          (Obsidian wraps in <em>/<strong>
  //                                       but those wrappers don't break
  //                                       the surrounding text node)
  // Keep whitespace as-is — Obsidian preserves the space between
  // surrounding text and the stripped label, so the prefix must too.
  let prefixSource = sectionSource.slice(
    Math.max(0, ref.sourceIndex - 30),
    ref.sourceIndex
  );
  prefixSource = prefixSource.replace(/`+[^`]*`+/g, "");
  prefixSource = prefixSource.replace(/\[([^\]]*)\]\([^\)]*\)/g, "$1");
  prefixSource = prefixSource.replace(/[\*_]/g, "");
  prefixSource = prefixSource.replace(/\s+/g, " ");
  const prefix = prefixSource.slice(-12);
  if (prefix.replace(/\s/g, "").length < 2) return false;

  const renderedLabel = ref.label.toLowerCase();
  const target = prefix + renderedLabel;

  // Walk the rendered DOM, collect every accepted text node, and search
  // their concatenation. A per-node search would miss matches whose
  // prefix straddles a skipped element like <code>…</code> — e.g.
  // source `and \`demo\`[^2]` renders as text(", and "), <code>demo</code>,
  // text("2."), and the prefix "and " ends in one node while the label
  // is in another.
  const skipParentSelector =
    "code, pre, .callout-title, .tufte-sidenote-ref, sup, .footnote-link, .footnote-ref, a";
  const textNodes = [];
  const walker = (root.ownerDocument || document).createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest(skipParentSelector)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);
  if (!textNodes.length) return false;

  const offsets = new Array(textNodes.length);
  let total = 0;
  for (let i = 0; i < textNodes.length; i++) {
    offsets[i] = total;
    total += textNodes[i].nodeValue.length;
  }
  const concat = textNodes.map((t) => t.nodeValue).join("");

  const idx = concat.indexOf(target);
  if (idx === -1) return false;

  const labelStartGlobal = idx + prefix.length;
  let nodeIdx = 0;
  while (
    nodeIdx < textNodes.length - 1 &&
    offsets[nodeIdx + 1] <= labelStartGlobal
  ) {
    nodeIdx++;
  }
  const node = textNodes[nodeIdx];
  const localOffset = labelStartGlobal - offsets[nodeIdx];
  if (
    localOffset < 0 ||
    localOffset + ref.label.length > node.nodeValue.length
  ) {
    return false;
  }

  const labelNode = node.splitText(localOffset);
  labelNode.splitText(ref.label.length);

  const sup = (root.ownerDocument || document).createElement("sup");
  sup.className = "tufte-sidenote-ref";
  sup.textContent = ref.label;
  sup.setAttribute("aria-label", `Sidenote ${ref.label}`);
  labelNode.parentNode.replaceChild(sup, labelNode);
  return true;
}

function wrapLiteralFootnoteRefsAsSup(root) {
  // Without a `[^N]:` definition, Obsidian's Reading-view renderer leaves
  // `[^N]` as literal text inside a paragraph. Walk those text nodes and
  // replace each match with a <sup class="tufte-sidenote-ref">N</sup>.
  // Skip code, pre, links, the callout title (which we use as the margin
  // label) and any text we've already wrapped on a previous pass.
  const skipParentSelector =
    'code, pre, a, .callout-title, .tufte-sidenote-ref, sup.footnote-ref';
  const candidates = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.includes("[^")) {
        return NodeFilter.FILTER_REJECT;
      }
      if (node.parentElement?.closest(skipParentSelector)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node;
  while ((node = walker.nextNode())) candidates.push(node);

  for (const textNode of candidates) {
    const text = textNode.nodeValue;
    const matches = Array.from(text.matchAll(/\[\^([^\]\s]+)\]/g));
    // Skip definitions: `[^N]:` is a footnote DEFINITION, not a call site.
    const refMatches = matches.filter(
      (m) => text[m.index + m[0].length] !== ":"
    );
    if (!refMatches.length) continue;

    const doc = textNode.ownerDocument;
    const fragment = doc.createDocumentFragment();
    let lastEnd = 0;
    for (const m of refMatches) {
      const before = text.slice(lastEnd, m.index);
      if (before) fragment.appendChild(doc.createTextNode(before));
      const sup = doc.createElement("sup");
      sup.className = "tufte-sidenote-ref";
      sup.textContent = m[1];
      sup.setAttribute("aria-label", `Sidenote ${m[1]}`);
      fragment.appendChild(sup);
      lastEnd = m.index + m[0].length;
    }
    const tail = text.slice(lastEnd);
    if (tail) fragment.appendChild(doc.createTextNode(tail));
    textNode.parentNode.replaceChild(fragment, textNode);
  }
}

function labelFromHref(value) {
  if (!value) return null;
  const hashIndex = value.indexOf("#");
  const raw = hashIndex === -1 ? value : value.slice(hashIndex + 1);
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const m = decoded.match(/^fn(?:ref)?-(.+?)(?:-[A-Za-z0-9]+)?$/i);
  if (m) return m[1];
  return null;
}

// --- legacy parsers (unchanged shape) -----------------------------------

function parseSidenoteDefinitions(source, references = parseFootnoteReferences(source)) {
  const lines = source.split(/\r?\n/);
  const sidenotes = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }

    if (inFence || !SIDENOTE_START_RE.test(lines[i])) continue;

    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const match = lines[j].match(BLOCKQUOTE_LINE_RE);
      if (!match) break;
      body.push(match[1]);
    }

    const definition = extractFirstFootnoteDefinition(body);
    if (!definition) {
      sidenotes.push(null);
      continue;
    }

    const key = normalizeFootnoteId(definition.id);
    sidenotes.push({
      id: definition.id,
      lineStart: i,
      lineEnd: definition.lineEnd + i + 1,
      markdown: definition.markdown,
      label: references.byKey.get(key) || definition.id.trim()
    });
  }

  return sidenotes;
}

function extractFirstFootnoteDefinition(lines) {
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(FOOTNOTE_DEF_RE);
    if (!match) continue;

    const body = [match[2]];
    for (let j = i + 1; j < lines.length; j++) {
      if (FOOTNOTE_DEF_RE.test(lines[j])) break;
      body.push(lines[j].replace(/^\s{2,4}/, ""));
    }

    return {
      id: match[1],
      lineEnd: i + body.length - 1,
      markdown: body.join("\n").trim()
    };
  }

  return null;
}

function parseFootnoteReferences(source) {
  const lines = source.split(/\r?\n/);
  const ordered = [];
  const byKey = new Map();
  let inFence = false;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const rawLine = lines[lineNumber];

    if (FENCE_RE.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const line = stripInlineCode(rawLine);

    FOOTNOTE_REF_RE.lastIndex = 0;
    let match;
    while ((match = FOOTNOTE_REF_RE.exec(line))) {
      const nextChar = line[match.index + match[0].length];
      if (nextChar === ":") continue;

      const label = match[1].trim();
      const key = normalizeFootnoteId(label);
      ordered.push({
        key,
        label,
        line: lineNumber
      });
      if (!byKey.has(key)) {
        byKey.set(key, label);
      }
    }
  }

  return { ordered, byKey };
}

function findLegacySidenoteByText(callout, sidenotes) {
  const text = normalizeRenderedText(callout.textContent);
  if (!text) return null;
  for (const sidenote of sidenotes) {
    if (!sidenote?.markdown) continue;
    const md = normalizeRenderedText(sidenote.markdown);
    if (md && (text.includes(md) || md.includes(text))) {
      return sidenote;
    }
  }
  return null;
}

function getSectionInfo(ctx, el) {
  try {
    return ctx.getSectionInfo?.(el) || null;
  } catch {
    return null;
  }
}

function getSectionSource(source, sectionInfo) {
  if (typeof sectionInfo?.text === "string") {
    return sectionInfo.text;
  }

  if (!hasLineRange(sectionInfo)) return null;

  return source
    .split(/\r?\n/)
    .slice(sectionInfo.lineStart, sectionInfo.lineEnd + 1)
    .join("\n");
}

function filterSidenotesBySection(sidenotes, sectionInfo) {
  if (!hasLineRange(sectionInfo)) return sidenotes;

  return sidenotes.filter(
    (sidenote) =>
      sidenote &&
      isLineInSection(sidenote.lineStart, sectionInfo) &&
      isLineInSection(sidenote.lineEnd, sectionInfo)
  );
}

function hasLineRange(sectionInfo) {
  return (
    sectionInfo &&
    Number.isFinite(sectionInfo.lineStart) &&
    Number.isFinite(sectionInfo.lineEnd)
  );
}

function isLineInSection(line, sectionInfo) {
  return line >= sectionInfo.lineStart && line <= sectionInfo.lineEnd;
}

function extractFootnoteIdFromText(text) {
  const match = String(text || "").match(/\[\^([^\]]+)\]:/);
  return match?.[1]?.trim() || "";
}

function extractBracketedFootnoteRefLabel(text) {
  const match = String(text || "").match(/\[\^([^\]\s]+)\]/);
  return match?.[1]?.trim() || "";
}

function extractVisibleFootnoteLabel(link) {
  const text = (link.textContent || "").trim();
  const match = text.match(/^\[(.+)\]$/);
  return match ? match[1] : text;
}

function normalizeRenderedText(text) {
  return String(text || "")
    .replace(/\[\^[^\]]+\]:/g, "")
    .replace(/[`*_~\[\]()#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function removeFootnoteTail(root) {
  if (!root) return;
  root
    .querySelectorAll(
      '.footnotes, ol:has(> li[data-footnote-id^="fn-"]), ol:has(> li[id^="fn-"])'
    )
    .forEach((node) => node.remove());
}

function getDocumentRoot(root) {
  return (
    root.closest?.(".markdown-preview-view") ||
    root.closest?.(".markdown-rendered") ||
    root
  );
}

async function renderMarkdown(app, markdown, el, sourcePath, component) {
  if (MarkdownRenderer.render) {
    await MarkdownRenderer.render(app, markdown || " ", el, sourcePath, component);
    return;
  }

  await MarkdownRenderer.renderMarkdown(markdown || " ", el, sourcePath, component);
}

function normalizeFootnoteId(id) {
  return String(id).trim().toLowerCase();
}

function stripInlineCode(line) {
  return line.replace(/`+[^`]*`+/g, "");
}

function uniqueElements(nodes) {
  return Array.from(new Set(Array.from(nodes)));
}

function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return String(hash);
}

// --- editor commands: insert marginalia at cursor ----------------------

function insertSidenoteAtCursor(editor) {
  const cursor = editor.getCursor();
  const source = editor.getValue();
  const label = String(nextNumericFootnoteLabel(source));

  // Insert [^N] at the cursor (or replace selection).
  editor.replaceRange(`[^${label}]`, cursor);

  // Insert the callout block after the current paragraph, separated by a
  // blank line. Place the cursor inside the callout body so the user can
  // type immediately.
  const paragraphEndLine = findParagraphEndLine(editor, cursor.line);
  insertCalloutBlock(editor, paragraphEndLine, `[!sidenote] ${label}`);
}

function insertMarginnoteAtCursor(editor) {
  const cursor = editor.getCursor();
  const paragraphEndLine = findParagraphEndLine(editor, cursor.line);
  insertCalloutBlock(editor, paragraphEndLine, "[!marginnote]");
}

function insertEpigraphAtCursor(editor) {
  const cursor = editor.getCursor();
  const paragraphEndLine = findParagraphEndLine(editor, cursor.line);
  insertCalloutBlock(editor, paragraphEndLine, "[!epigraph]");
}

function insertCalloutBlock(editor, paragraphEndLine, headerSpec) {
  const lineText = editor.getLine(paragraphEndLine) || "";
  const endCh = lineText.length;
  const isEmpty = /^\s*$/.test(lineText);

  // No blank line between the prose and the callout — the callout sits
  // immediately on the line below the paragraph for tighter typography.
  // If the paragraph-end line itself is already blank (rare — only the
  // cursor-on-trailing-blank case), write the header onto it directly.
  const insertion = isEmpty
    ? `> ${headerSpec}\n> `
    : `\n> ${headerSpec}\n> `;

  editor.replaceRange(insertion, { line: paragraphEndLine, ch: endCh });

  // Body line offset: 2 newlines before the body when prepending "\n",
  // 1 newline when written onto an existing blank line.
  const bodyLine = paragraphEndLine + (isEmpty ? 1 : 2);
  editor.setCursor({ line: bodyLine, ch: 2 });
  editor.focus?.();
}

function findParagraphEndLine(editor, fromLine) {
  const last = editor.lineCount() - 1;
  let i = Math.min(Math.max(fromLine, 0), last);
  while (i < last) {
    const next = editor.getLine(i + 1) || "";
    // Stop on blank line, heading boundary, or block boundary so the
    // callout lands at the end of the prose paragraph (or current
    // block), not several paragraphs down.
    if (/^\s*$/.test(next)) break;
    if (/^\s*#{1,6}\s/.test(next)) break;
    if (/^\s*(```|~~~)/.test(next)) break;
    i++;
  }
  return i;
}

function nextNumericFootnoteLabel(source) {
  const lines = source.split(/\r?\n/);
  let max = 0;
  let inFence = false;
  for (const rawLine of lines) {
    if (FENCE_RE.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = stripInlineCode(rawLine);
    let m;
    const re = /\[\^(\d+)\]/g;
    while ((m = re.exec(line))) {
      const next = line[m.index + m[0].length];
      if (next === ":") continue; // definition, not a ref
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}
