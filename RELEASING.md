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

## The plugins (separate track, when ready)

Community **plugins** (unlike themes) each need their **own repository** — the submission form takes one repo per plugin, and the release must attach `main.js`, `manifest.json`, and `styles.css` as loose assets (not a zip). To submit later:

1. Create `PleiadesM/tufte-sidenotes`, `PleiadesM/tufte-figures`, `PleiadesM/tufte-inline`; move each plugin's files to its repo root (they live in `plugins/` here for now).
2. Each repo: `README.md`, `LICENSE`, `manifest.json` at root; release tagged with the manifest version, assets `main.js` + `manifest.json` (+ `styles.css`).
3. Submit each at community.obsidian.md the same way.
4. The plugin ids (`tufte-sidenotes`, `tufte-figures`, `tufte-inline`) must stay stable forever once published.

Until then, users install the plugins manually from this repo's release zips, or beta-test them via BRAT once they have their own repos.

## Testing a release before announcing

1. In a **fresh vault** (not the dev vault), Settings → Appearance → Themes → the theme won't be in Browse yet — copy the two release assets into `.obsidian/themes/Tufte/` and select it.
2. Unzip the plugin assets into `.obsidian/plugins/`, enable, and walk the checklist: sidenotes in margins, figure drop modal, `[!banner]`, a Bases table + cards view, dark mode, and the bilingual CJK sample.
3. Only then submit / announce (GitHub, RedNote per the Working Document's publishing stage).
