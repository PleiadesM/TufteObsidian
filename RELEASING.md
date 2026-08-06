# Releasing Tufte for Obsidian

A working checklist for cutting releases and submitting to the Obsidian community directories. Verified against docs.obsidian.md as of 2026-08.

## Cutting a theme release (every version)

1. In the dev vault, bump `version` in `.obsidian/themes/Tufte/manifest.json` (semver `x.y.z`, no `v` prefix).
2. Copy `theme.css` + `manifest.json` to this repo's root; commit and push.
3. Create a GitHub release whose **tag exactly matches the manifest version**, with `theme.css` and `manifest.json` attached as assets:

```bash
gh release create 1.15.1 theme.css manifest.json --title "Tufte 1.15.1" --notes "…"
```

Obsidian's theme updater reads the latest release, so users get the new version from Settings → Appearance → Themes → check for updates.

## Submitting the theme to the community directory (once)

Requirements the repo already satisfies:

- `theme.css`, `manifest.json`, `README.md`, `LICENSE`, and a screenshot at the repo root (recommended 512×288 or another 16:9 size).
- A GitHub release tagged with the manifest version, with `theme.css` + `manifest.json` as assets.
- **No network calls** — fonts and images must be embedded (ET Book is inlined as data URIs; nothing remote remains).
- The theme name ("Tufte") is unique in the directory — checked 2026-08-01, no conflict.

Steps:

1. Go to **community.obsidian.md**, sign in, and link your GitHub account (PleiadesM).
2. Agree to the developer policies (no telemetry, no remote assets, honest LICENSE — all already true).
3. Submit the repository URL `https://github.com/PleiadesM/TufteObsidian`.
4. Automated validation runs first (manifest fields, release assets, remote-asset scan); then human review. Review feedback arrives on the submission — expect days to a few weeks.
5. Once accepted, the theme appears in Settings → Appearance → Themes → Browse. Later versions need only the release ritual above — no re-submission.

Notes for review:

- The stylesheet uses `!important` in places (tables, banner geometry) where it must beat Obsidian's inline styles; the guidelines discourage casual use, so if a reviewer asks, each instance is commented with its reason in `theme.css`.
- `modes` for the directory entry: both light and dark are supported.

## The plugin (separate track)

Community **plugins** (unlike themes) need their **own repository**, and the release must attach `main.js`, `manifest.json`, and `styles.css` as loose assets (not a zip).

Since 2026-08-05 there is exactly one: **[PleiadesM/tufte-suite](https://github.com/PleiadesM/tufte-suite)** — Tufte Suite, which carries the former four plugins as switchable modules. It has its own `README.md`, MIT `LICENSE`, the plugin files at the repo root, the four module sources under `src/modules/`, and a jsdom equivalence harness under `tests/`.

Cutting a Suite release:

1. In the dev vault, land and GUI-confirm the change in `.obsidian/plugins/<module-id>/` as before.
2. Copy the changed module files to the Suite repo's `src/modules/<module-id>/`, bump `version` in the Suite's root `manifest.json`, and rebuild:

```bash
node build-tufte-suite.js   # regenerates main.js + styles.css from src/modules/
cd tests && npm install && node run-all.js
```

3. Commit and push, then create a release whose **tag exactly matches the manifest version** (no `v` prefix):

```bash
gh release create 1.0.1 main.js manifest.json styles.css --title "Tufte Suite 1.0.1" --notes "…"
```

Never hand-edit the Suite's `main.js` — it is generated, and the build asserts that every embedded module matches its source byte-for-byte.

### The four standalone plugins are archived

Tufte Sidenotes, Tufte Figures, Tufte Inline, and Tufte Backlinks shipped separately until 2026-08-05 (final versions 1.7.0 / 1.7.2 / 1.2.0 / 1.0.1). Tufte Suite 1.0.0 supersedes all four. Their repositories and the copies in [`plugins/`](plugins) are **frozen** — kept for history, never updated:

| Plugin id | Archived repository | Final release |
|---|---|---|
| `tufte-sidenotes` | [PleiadesM/Tufte-Sidenote](https://github.com/PleiadesM/Tufte-Sidenote) | 1.7.0 |
| `tufte-figures` | [PleiadesM/Tufte-Sidenotes](https://github.com/PleiadesM/Tufte-Sidenotes) ⚠️ | 1.7.2 |
| `tufte-inline` | [PleiadesM/Tufte-Inline](https://github.com/PleiadesM/Tufte-Inline) | 1.2.0 |
| `tufte-backlinks` | [PleiadesM/Tufte-Backlinks](https://github.com/PleiadesM/Tufte-Backlinks) | 1.0.1 |

⚠️ **The figures plugin's repo is named `Tufte-Sidenotes` (plural) on purpose** — the community portal's registry row from the first (mixed-up) submission maps id `tufte-figures` to a repo of that name, and the row can't be changed from our side, so the repo was renamed to satisfy it. The *actual* sidenotes plugin lives in `Tufte-Sidenote` (singular). The trap only matters now if you ever revisit those archived repos.

Plugin ids stay stable forever once published — including the four module ids inside the Suite, which is why the Suite keeps them (and their command ids, so users' hotkeys survive the move).

Submission: the Suite needs its own one-time submission at community.obsidian.md, same flow as the theme. If any of the four were already accepted into the directory, deprecate those entries rather than updating them.

The full change flow — dev vault → Suite repo → release — is documented in the dev vault's `CLAUDE.md` (sync discipline).

## Testing a release before announcing

1. In a **fresh vault** (not the dev vault), Settings → Appearance → Themes → the theme won't be in Browse yet — copy the two release assets into `.obsidian/themes/Tufte/` and select it.
2. Unzip the plugin assets into `.obsidian/plugins/`, enable, and walk the checklist: sidenotes in margins, figure drop modal, `[!banner]`, a Bases table + cards view, dark mode, and the bilingual CJK sample.
3. Only then submit / announce (GitHub, RedNote per the Working Document's publishing stage).
