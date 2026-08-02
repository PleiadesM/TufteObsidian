# Tufte for Obsidian

An [Obsidian](https://obsidian.md) theme adapted from [Tufte CSS](https://edwardtufte.github.io/tufte-css/), carrying Edward Tufte's book design — ET Book type, marginalia, restrained rules, one deliberate red — into every corner of the app, with a full Chinese typographic system (宋体正文、楷体示例、黑体数据) alongside the Latin one.

![Tufte for Obsidian — the Bases bookshelf gallery, light and dark.](screenshot.png)

## What the theme covers

- **Typography** — ET Book (embedded, offline; MIT-licensed) with Palatino/Georgia fallbacks; Gill Sans for data and chrome; a 55rem reading measure with a marginalia gutter; lining tabular figures wherever digits stack.
- **Tables and Bases** — prose tables and Obsidian's Bases database views share one specimen-table register modeled on *Beautiful Evidence*: a single hairline under the head, no vertical rules, alignment does the work. The Bases **cards view renders as a bookshelf gallery** — frameless covers on a shelf line with centered title-page captions.
- **Banners** — a CSS-native `[!banner]` callout that opens a note with a full-bleed plate, the way Tufte's chapters open.
- **Quiet chrome** — sidebars, tabs, menus, and the graph in paper-and-ink; glass chrome at 95% opacity with a frost, including a whole-window translucent mode (three Style Settings sliders).
- **Chinese typography** — 宋体 body, 楷体 for italic contexts (epigraphs, captions, attributions), 黑体 for data labels, punctuation squeeze at wraps, and CJK-aware fallbacks for Windows.
- **Tags, highlights, callouts** — colored text instead of pills; a six-hue accessory palette held below the accent's chroma so red keeps its pointer meaning.

Light and dark modes throughout; WCAG AA contrast documented in the stylesheet.


### Sidenote Function as Edward Tufte's Handout Design
One of the core features of Tufte's handout and book design is the sidenote, which can be traced back to the [Marginalia](https://en.wikipedia.org/wiki/Marginalia) commentary. I found this feature helpful for my note-taking process—once I started to use it, I gradually found many places to insert a sidenote where I didn't notice before.

<img width="809" height="167" alt="Sidenote-1" src="https://github.com/user-attachments/assets/fc615a85-6823-48c3-a30b-ed5bbc84c1d0" />
<img width="813" height="218" alt="Sidenote-2" src="https://github.com/user-attachments/assets/2feea790-b8b5-477a-936e-c3d05449cc8e" />

### Backlink Renderer
Backlinks are a core feature of the [Zettelkasten](https://en.wikipedia.org/wiki/Zettelkasten) (or slipbox) note-taking method. I made a plugin so that it renders the Markdown format instead of displaying the source code directly.

<img width="819" height="289" alt="BacklinkRender" src="https://github.com/user-attachments/assets/b8335034-de97-4816-85d8-5b86c93ec1aa" />

### Enhancing Figure Function 
The theme supports three modes of figure display, including displaying figures on the sidenote area.

<img width="812" height="518" alt="FigureMode-1" src="https://github.com/user-attachments/assets/4b41b036-0d3e-470e-97db-90364d71e714" />
<img width="860" height="607" alt="FigureMode-2" src="https://github.com/user-attachments/assets/24bbcb28-e240-4b35-bfa9-1bd83b463d72" />
<img width="833" height="606" alt="FigureMode-3" src="https://github.com/user-attachments/assets/c521476d-d62f-46f1-a280-8271e50662bb" />

If you drag the image into the pane, a modal will pop up and ask you for more details of that figure, including captions, numbers, and names. It also supports multiple image displays and [image quilts](http://imagequilts.com/).

<img width="545" height="707" alt="FigureSetting" src="https://github.com/user-attachments/assets/a9f18cc3-0c6a-4b59-8c57-26cbbe8516d9" />
<img width="851" height="453" alt="ImageQuilt" src="https://github.com/user-attachments/assets/08cc4703-e9dc-4003-9ed2-6746cab96853" />

## Companion plugins

The theme stands alone, but four plugins in [`plugins/`](plugins) complete the Tufte writing system:

| Plugin | What it does |
|---|---|
| **Tufte Sidenotes** | Renders `[^…]` footnotes and `[!sidenote]`/`[!marginnote]` callouts as true sidenotes in the margin gutter (Reading view), keeping the editor single-column. |
| **Tufte Figure Helper** | Drop or paste an image to compose column, full-width, and margin figures with proper captions; multi-image rows; an image-quilt generator; auto-numbered references. |
| **Tufte Inline** | Inline shorthands: `^^text^^` small-caps openers, `&&text&&` italic run-ins, `@@字@@` two-line CJK drop caps. |
| **Tufte Backlinks** | Renders Linked/Unlinked mention snippets as formatted Markdown — headings at body size, the backlink reference itself bold, underlined and accent red. |

## Install

**Theme (manual, until it reaches the community directory):**

1. Download `theme.css` and `manifest.json` from the [latest release](../../releases/latest).
2. Put them in `YourVault/.obsidian/themes/Tufte/`.
3. Settings → Appearance → Themes → select **Tufte**.

**Plugins (manual):**

1. Download the plugin zips from the [latest release](../../releases/latest).
2. Unzip into `YourVault/.obsidian/plugins/` (one folder per plugin).
3. Settings → Community plugins → enable each one.

Optional: install the community **Style Settings** plugin to get sliders for the glass chrome (opacity, blur, translucent-window sheet).

## Requirements

- Obsidian 1.4.0 or newer (Bases styling targets 1.9+).
- No fonts to install and no network access needed — ET Book is embedded in the stylesheet.

## Credits

- [Tufte CSS](https://github.com/edwardtufte/tufte-css) by Dave Liepmann and contributors — the typographic source this theme adapts.
- [ET Book](https://github.com/edwardtufte/et-book) © Dmitry Krasny, Bonnie Scranton, Edward Tufte, Adam Schwartz — MIT license, embedded in `theme.css`.
- Edward Tufte's books — *The Visual Display of Quantitative Information*, *Envisioning Information*, *Visual Explanations*, *Beautiful Evidence* — the design authority behind every decision here.

## License

[MIT](LICENSE) © 2026 Daocheng Lin. The embedded ET Book fonts remain under their own MIT license and copyright.
