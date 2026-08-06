# Archived — these four plugins are superseded by Tufte Suite

As of **2026-08-05**, the four plugins in this folder are frozen. They are kept for history and receive no further updates.

They are replaced by **[Tufte Suite](https://github.com/PleiadesM/tufte-suite)**, a single plugin that carries all four as switchable modules. All future plugin work happens in that repository.

| Plugin id | Final standalone version | Archived repository |
|---|---|---|
| `tufte-sidenotes` | 1.7.0 | [PleiadesM/Tufte-Sidenote](https://github.com/PleiadesM/Tufte-Sidenote) |
| `tufte-figures` | 1.7.2 | [PleiadesM/Tufte-Sidenotes](https://github.com/PleiadesM/Tufte-Sidenotes) (plural — deliberate; see `RELEASING.md`) |
| `tufte-inline` | 1.2.0 | [PleiadesM/Tufte-Inline](https://github.com/PleiadesM/Tufte-Inline) |
| `tufte-backlinks` | 1.0.1 | [PleiadesM/Tufte-Backlinks](https://github.com/PleiadesM/Tufte-Backlinks) |

## Why

Four plugins meant four installs, four update prompts, and four settings pages for what is really one writing system built around one theme. The Suite makes it one install, with each feature still independently switchable in Settings → Tufte Suite.

## Nothing was rewritten

The Suite does not reimplement these plugins — it **embeds their source byte-for-byte** as modules, so behavior is identical. The files here are the exact code now running inside Tufte Suite 1.0.0, and the same sources live in that repo under `src/modules/`, where development continues. A jsdom equivalence harness in the Suite repo loads each module both standalone and through the Suite and requires the rendered DOM to match.

## If you still have the four installed

Disable all four before enabling Tufte Suite — running both renders everything twice. The Suite imports their settings and image-quilt store on first load (reading the old folders, never writing to them) and keeps the same command ids, so bound hotkeys keep working.
