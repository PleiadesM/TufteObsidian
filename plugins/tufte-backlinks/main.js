const { Component, MarkdownRenderer, Plugin } = require("obsidian");

/* ============================================================================
   Tufte Backlinks — render "Linked mentions" / "Unlinked mentions" snippets
   as formatted Markdown instead of raw source.

   Obsidian's core backlink plugin inserts each mention as PLAIN TEXT, so
   `**bold**`, `[[wikilinks]]` and `# headings` show their markers. The theme
   can only style that text; turning it into rendered Markdown needs JS, hence
   this companion plugin.

   Two behaviours the rest of the file exists to protect:

     1. A heading caught in a snippet must read at BODY size. The markers are
        stripped before rendering (so inline formatting inside the heading
        text still renders) and styles.css keeps an h1–h6 safety net for
        anything the stripper misses.
     2. In Linked mentions, the link that resolves to the page whose backlinks
        are being shown — the backlink reference itself — is tagged
        `tufte-backlinks-target` + `search-result-file-matched-text`, and the
        stylesheet renders it bold + underlined + accent red. Links to OTHER
        pages in the same snippet render normally.

   Everything keys off `.backlink-pane`, which covers the sidebar pane AND the
   in-document block (`.embedded-backlinks` wraps a `.backlink-pane`), and
   structurally excludes the global Search pane.

   The real shape of a `.search-result-file-match` (read out of the Obsidian
   1.13 bundle, after a first attempt assumed otherwise):

     - The snippet is NOT bare text. Obsidian's span renderer wraps EVERY run:
       non-matched runs in CLASS-LESS `<span>`s, matched runs in
       `span.search-result-file-matched-text`. Line breaks arrive as literal
       `\n` inside a span's text, not reliably as `<br>`.
     - The match element also holds Obsidian's own live CHROME: the
       `div.search-result-hover-button.mod-top` / `.mod-bottom` "show more
       context" chevrons, built in the constructor, and — on unlinked
       mentions, appended later — the `button.search-result-file-match-replace-button`
       ("Link") action. Child order can be chevrons, then spans, then button.

   So the plugin distinguishes CONTENT (which it replaces with the rendered
   wrapper) from CHROME (which it leaves in place, untouched, throughout the
   swap, the unload restore, and the observer's foreign-add test).
   ============================================================================ */

const MARK_ATTR = "data-tufte-backlinks";
const RENDERED_CLASS = "tufte-backlinks-rendered";
const TARGET_CLASS = "tufte-backlinks-target";
// Obsidian's own class for a matched run. Re-applying it (rather than a
// plugin-private class) keeps theme.css's linked-red / unlinked-muted-dotted
// sibling rules working against rendered content, unchanged.
const HIGHLIGHT_CLASS = "search-result-file-matched-text";
// Obsidian's live controls inside a match: the "show more context" chevrons
// and, on unlinked mentions, the "Link" action button. Never our content.
const CHROME_SELECTOR =
  ".search-result-hover-button, .search-result-file-match-replace-button";
const DEBOUNCE_MS = 120;

// Ellipsis-tolerant: a snippet is a slice of the note, so a heading line can
// arrive as "…# Reference". Keep the indent and the ellipsis, drop the hashes.
const ATX_HEADING_RE = /^(\s*)((?:…|\.\.\.)\s*)?#{1,6}\s+/;
const SETEXT_UNDERLINE_RE = /^\s*(={2,}|-{2,})\s*$/;

module.exports = class TufteBacklinksPlugin extends Plugin {
  async onload() {
    // One long-lived child Component owns every render, so MarkdownRenderer's
    // per-render children (embeds, math, callouts) unload with the plugin
    // instead of leaking one Component per mention.
    this.renderComp = new Component();
    this.addChild(this.renderComp);

    this.processTimer = 0;
    this.renderToken = 0;
    // Element -> token of the render currently in flight for it. A marked
    // element with no rendered child is ambiguous — either Obsidian rewrote it
    // in place, or its render simply hasn't landed yet — and only this tells
    // the two apart.
    this.pending = new WeakMap();

    this.registerBacklinkObserver();

    const schedule = () => this.scheduleProcess();
    this.registerEvent(this.app.workspace.on("layout-change", schedule));
    this.registerEvent(this.app.workspace.on("active-leaf-change", schedule));
    this.registerEvent(this.app.workspace.on("file-open", schedule));
    this.app.workspace.onLayoutReady(() => this.processAll());
  }

  onunload() {
    // Observers, events and the timer are unwound by register*(); the DOM is
    // not. Put the raw snippets back so disabling the plugin returns the pane
    // to its native state immediately (Obsidian regenerates the native match
    // highlights on the next natural refresh).
    document.querySelectorAll("[" + MARK_ATTR + "]").forEach((el) => {
      const wrapper = el.querySelector(":scope > ." + RENDERED_CLASS);
      const raw = el.dataset.tufteBacklinksRaw;
      // Swap the wrapper back out for the raw text in place — never
      // `el.textContent = raw`, which would take Obsidian's chrome with it.
      // No wrapper means the render never landed (in flight, or the error
      // sentinel); then there is nothing to put back.
      if (wrapper && typeof raw === "string") {
        el.insertBefore(document.createTextNode(raw), wrapper);
        wrapper.remove();
      }
      delete el.dataset.tufteBacklinks;
      delete el.dataset.tufteBacklinksRaw;
    });
  }

  registerBacklinkObserver() {
    // childList only — the plugin's own dataset writes are attribute changes,
    // and characterData would fire on every keystroke reflected into a mention.
    const observer = new MutationObserver((records) => {
      // The whole batch is scanned, never short-circuited on the first record
      // worth acting on: one batch can carry an invalidation for each of
      // SEVERAL marked elements, and a skipped one leaves its in-flight render
      // alive to land stale content over Obsidian's new text. Scheduling is
      // hoisted out of the loop instead — the pass is debounced anyway.
      let schedule = false;

      for (const record of records) {
        const node = record.target;
        const target =
          node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (!target) continue;

        // A mutation on or under a match this plugin already took needs three
        // cases told apart — the first two are the plugin's own work echoing
        // back, and re-entering on those is an infinite loop.
        const marked = target.closest("[" + MARK_ATTR + "]");
        if (marked) {
          // Deeper than the match itself: the wrapper filling in, or
          // MarkdownRenderer's async post-processing. Always ours.
          if (target !== marked) continue;
          // On the match itself: the swap-in adds exactly the rendered
          // wrapper, and Obsidian appends the "Link" button to an unlinked
          // mention on its own schedule — neither means the element was
          // reclaimed. Anything ELSE added does. (Pure-removal records add
          // nothing and fall through here; the foreign ADD that follows does
          // the work.)
          const foreignAdd = Array.prototype.some.call(
            record.addedNodes,
            (added) =>
              !(
                (added.nodeType === Node.ELEMENT_NODE &&
                  added.classList.contains(RENDERED_CLASS)) ||
                isChromeEl(added)
              )
          );
          if (!foreignAdd) continue;
          // Obsidian rewrote a processed match in place. Dropping the mark
          // both frees the element for immediate reprocessing and invalidates
          // any in-flight render, whose token check will now fail — stale
          // content can never land on top of Obsidian's new text. No
          // `.backlink-pane` re-check: a marked element only ever exists
          // inside one.
          delete marked.dataset.tufteBacklinks;
          delete marked.dataset.tufteBacklinksRaw;
          schedule = true;
          continue;
        }

        if (!target.closest(".backlink-pane")) continue;
        schedule = true;
      }

      if (schedule) this.scheduleProcess();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    this.register(() => observer.disconnect());
    this.register(() => window.clearTimeout(this.processTimer));
  }

  // Trailing debounce: Obsidian rebuilds the pane in bursts (collapse/expand,
  // re-search on edit), and only the settled DOM is worth rendering.
  scheduleProcess() {
    window.clearTimeout(this.processTimer);
    this.processTimer = window.setTimeout(() => {
      this.processTimer = 0;
      this.processAll();
    }, DEBOUNCE_MS);
  }

  processAll() {
    const workspace = this.app.workspace;
    const activeFile = workspace.getActiveFile();
    // root element -> the file whose mentions that root shows. Needed per root
    // because several panes can be open at once (sidebar + two split notes,
    // each with its own in-document backlinks).
    const roots = new Map();

    for (const leaf of workspace.getLeavesOfType("backlink")) {
      const container = leaf.view && leaf.view.containerEl;
      if (!container) continue;
      // A pinned backlink view carries its own file; an unpinned one follows
      // the active note and may not expose one.
      roots.set(container, (leaf.view && leaf.view.file) || activeFile);
    }
    for (const leaf of workspace.getLeavesOfType("markdown")) {
      const container = leaf.view && leaf.view.containerEl;
      if (!container) continue;
      const file = (leaf.view && leaf.view.file) || null;
      container
        .querySelectorAll(".embedded-backlinks")
        .forEach((node) => roots.set(node, file));
    }

    roots.forEach((targetFile, root) => {
      root
        .querySelectorAll(".backlink-pane .search-result-file-match")
        .forEach((el) => this.considerMatch(el, targetFile));
    });
  }

  considerMatch(el, targetFile) {
    // Belt and braces: the global Search pane uses the same match class, and
    // must stay structurally untouched.
    if (el.closest('.workspace-leaf-content[data-type="search"]')) return;

    const mark = el.dataset.tufteBacklinks;
    if (mark === "error") return;
    if (mark) {
      if (el.querySelector(":scope > ." + RENDERED_CLASS)) return;
      // Marked, no rendered child, but a render is in flight: taken, not
      // clobbered. Clearing the mark here would restart that render — and
      // under continuous pane churn, restart it again on every pass.
      if (this.pending.has(el)) return;
      // Marked but no rendered child: Obsidian rewrote the match in place
      // (new search results reuse the element). Treat it as fresh.
      delete el.dataset.tufteBacklinks;
      delete el.dataset.tufteBacklinksRaw;
    }

    if (!isPlainSnippet(el)) return;
    // Not awaited: the mark is written synchronously inside, so a second pass
    // arriving mid-render sees the element as taken.
    this.renderMatch(el, targetFile);
  }

  async renderMatch(el, targetFile) {
    const raw = readSnippetText(el);
    const highlights = Array.prototype.map
      .call(el.querySelectorAll("." + HIGHLIGHT_CLASS), (n) => n.textContent)
      .filter((text) => text && text.trim());

    const token = String(++this.renderToken);
    el.dataset.tufteBacklinks = token;
    el.dataset.tufteBacklinksRaw = raw;
    this.pending.set(el, token);

    try {
      const sourcePath = resolveSourcePath(this.app, el);
      const wrapper = document.createElement("div");
      wrapper.className = RENDERED_CLASS;

      try {
        // Rendered DETACHED, then swapped in one move — the pane never shows
        // an empty match while the renderer is mid-flight.
        await renderMarkdown(
          this.app,
          preprocessSnippet(raw),
          wrapper,
          sourcePath,
          this.renderComp
        );
      } catch (error) {
        // Sentinel rather than an unmark: a snippet the renderer chokes on
        // would otherwise be retried on every observer tick.
        el.dataset.tufteBacklinks = "error";
        return;
      }

      removeFootnoteTail(wrapper);
      tagTargetLinks(this.app, wrapper, sourcePath, targetFile);
      reapplyHighlights(wrapper, highlights);

      // The pane may have been rebuilt while awaiting; a stale render must not
      // land on a recycled element.
      if (!el.isConnected || el.dataset.tufteBacklinks !== token) return;

      // Content out, wrapper in — but the chrome stays exactly where it is.
      // The hover chevrons and the unlinked "Link" button are Obsidian's own
      // live controls; `replaceChildren` would delete them (and their
      // handlers) along with the text.
      const contentNodes = Array.prototype.filter.call(
        el.childNodes,
        (node) => !isChromeEl(node)
      );
      el.insertBefore(wrapper, contentNodes[0] || null);
      contentNodes.forEach((node) => node.remove());
    } finally {
      // Token-conditional: if an overlapping newer render has already claimed
      // this element, its pending entry is not this one's to clear.
      if (this.pending.get(el) === token) this.pending.delete(el);
    }
  }
};

/* ---- Reading the native snippet ----------------------------------------- */

function isChromeEl(node) {
  return node.nodeType === Node.ELEMENT_NODE && node.matches(CHROME_SELECTOR);
}

// The fail-safe boundary: exactly the shapes Obsidian builds a text snippet
// out of. A class-less span is one of its plain runs — but only if it holds
// nothing but text, since a span carrying real structure would mean this is
// some other kind of match than the one modeled here.
function isContentNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return true;
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return true;
  if (tag !== "span") return false;
  if (!node.classList.contains(HIGHLIGHT_CLASS) && node.classList.length !== 0) {
    return false;
  }
  // The text/br-only requirement covers highlight spans and class-less runs
  // alike, deliberately: readSnippetText reads run spans by their children's
  // nodeValue, so a span with element structure would be read as empty. It
  // has to fail the guard, not slip through it.
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === "br") {
      continue;
    }
    return false;
  }
  return true;
}

// Only text snippets get rendered. Property matches and any future DOM stay
// native — as does a match holding nothing but chrome (nothing to render).
function isPlainSnippet(el) {
  let hasContent = false;
  for (const node of el.childNodes) {
    if (isChromeEl(node)) continue;
    if (!isContentNode(node)) return false;
    hasContent = true;
  }
  return hasContent;
}

// textContent over the whole element would sweep in the chrome's own labels
// and lose the `<br>` line breaks — and the per-line heading strip below
// depends on the lines. (Literal `\n` inside a run's text survives as-is.)
function readSnippetText(el) {
  let text = "";
  for (const node of el.childNodes) {
    if (isChromeEl(node)) continue;
    if (isBreak(node)) {
      text += "\n";
      continue;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      // A run span: its own children are text and breaks, same rule again.
      for (const child of node.childNodes) {
        text += isBreak(child) ? "\n" : child.nodeValue || "";
      }
      continue;
    }
    text += node.nodeValue || "";
  }
  return text;
}

function isBreak(node) {
  return node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === "br";
}

/* ---- Snippet -> Markdown ------------------------------------------------- */

function preprocessSnippet(raw) {
  const lines = String(raw || "").split("\n");
  const out = [];
  for (const line of lines) {
    // Setext underline under a non-blank line would promote that line to a
    // heading — the one heading form with no marker on the text line itself.
    const previous = out.length ? out[out.length - 1] : "";
    if (SETEXT_UNDERLINE_RE.test(line) && previous.trim()) continue;

    // Embeds would inject a whole note or image into the pane. Demoted to
    // ordinary links; styles.css keeps a display:none net for the rest.
    // The heading strip keeps one space after a leading ellipsis, so a
    // truncated "…# Reference" reads "… Reference", not "…Reference".
    out.push(
      line
        .replace(ATX_HEADING_RE, (match, indent, ellipsis) =>
          ellipsis ? indent + ellipsis.trimEnd() + " " : indent
        )
        .replace(/!(?=\[)/g, "")
    );
  }
  // Everything else is left alone: a snippet truncated mid-syntax renders as
  // literal text, which is exactly the status quo for that fragment.
  return dedentSnippet(out).join("\n");
}

// A snippet sliced from the middle of a nested list keeps its source
// indentation, but the fragment carries no parent list to anchor it — so a
// shared margin of a tab / 4+ spaces reads as an INDENTED CODE BLOCK and the
// whole mention renders monospace. Stripping the longest literal whitespace
// prefix the non-blank lines share restores the shallowest line to column 0
// while preserving relative nesting, so nested (task) lists render as lists.
// Literal prefix, not column math: a tab is never split, and if lines mix
// tabs and spaces the common prefix simply ends early (partial dedent — the
// status quo for that fragment). Known trade-off: a mention inside an
// INDENTED code block (the rare, non-fenced kind) is flattened to prose;
// fenced blocks keep their fences and still render as code.
function dedentSnippet(lines) {
  let prefix = null;
  for (const line of lines) {
    if (!line.trim()) continue; // blank lines don't vote
    const indent = (line.match(/^[ \t]*/) || [""])[0];
    if (prefix === null) {
      prefix = indent;
    } else {
      let i = 0;
      while (i < prefix.length && i < indent.length && prefix[i] === indent[i]) i++;
      prefix = prefix.slice(0, i);
    }
    if (!prefix) return lines;
  }
  if (!prefix) return lines;
  return lines.map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line));
}

// Resolving links relative to the note the mention lives in (not the note
// being viewed) is what makes relative wikilinks in the snippet land right.
function resolveSourcePath(app, el) {
  const active = app.workspace.getActiveFile();
  const activePath = active ? active.path : "";
  const title = readFileTitle(el);
  if (title) {
    const dest = app.metadataCache.getFirstLinkpathDest(title, activePath);
    if (dest) return dest.path;
  }
  return activePath;
}

function readFileTitle(el) {
  let item = el.closest(".tree-item");
  while (item) {
    const title = item.querySelector(":scope > .search-result-file-title");
    if (title) {
      // The title element also holds the match-count flair; the name lives in
      // `.tree-item-inner`.
      const inner = title.querySelector(".tree-item-inner");
      return (inner || title).textContent.trim();
    }
    item = item.parentElement && item.parentElement.closest(".tree-item");
  }
  return "";
}

/* ---- Post-processing the rendered snippet -------------------------------- */

function removeFootnoteTail(root) {
  if (!root) return;
  root
    .querySelectorAll(
      '.footnotes, ol:has(> li[data-footnote-id^="fn-"]), ol:has(> li[id^="fn-"])'
    )
    .forEach((node) => node.remove());
}

// Resolution-based, not text-based: this catches aliases (`[[Page|alias]]`),
// subpath links (`[[Page#heading]]`) and markdown-style links alike, while
// leaving links to other notes styled normally.
function tagTargetLinks(app, wrapper, sourcePath, targetFile) {
  if (!targetFile) return;
  wrapper.querySelectorAll("a.internal-link").forEach((link) => {
    const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
    const linkpath = href.split("#")[0].split("^")[0].trim();
    // A bare subpath (`[[#heading]]`) points inside its own note, never at the
    // target.
    if (!linkpath) return;
    const dest = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    if (dest && dest.path === targetFile.path) {
      link.classList.add(TARGET_CLASS, HIGHLIGHT_CLASS);
    }
  });
}

// Unlinked mentions match plain text, so nothing in the rendered output
// carries the highlight class — it has to be put back by string.
function reapplyHighlights(wrapper, texts) {
  for (const text of texts) {
    const needle = text.trim();
    if (!needle) continue;
    wrapTextOccurrence(wrapper, needle);
  }
}

function wrapTextOccurrence(wrapper, needle) {
  const doc = wrapper.ownerDocument || document;
  const walker = doc.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.includes(needle)) {
        return NodeFilter.FILTER_REJECT;
      }
      // Already highlighted — which includes the tagged target link, since it
      // carries the highlight class too.
      const parent = node.parentElement;
      if (!parent || parent.closest("." + HIGHLIGHT_CLASS)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const node = walker.nextNode();
  // Truncation and rendered-away syntax can make a captured match unfindable.
  // The mention still reads fine unhighlighted, so give up silently rather
  // than guess at a position.
  if (!node) return false;

  const middle = node.splitText(node.nodeValue.indexOf(needle));
  middle.splitText(needle.length);
  const span = doc.createElement("span");
  span.className = HIGHLIGHT_CLASS;
  middle.parentNode.replaceChild(span, middle);
  span.appendChild(middle);
  return true;
}

async function renderMarkdown(app, markdown, el, sourcePath, component) {
  if (MarkdownRenderer.render) {
    await MarkdownRenderer.render(app, markdown || " ", el, sourcePath, component);
    return;
  }

  await MarkdownRenderer.renderMarkdown(markdown || " ", el, sourcePath, component);
}
