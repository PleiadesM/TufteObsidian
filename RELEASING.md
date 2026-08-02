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

## The plugins (separate track)

Community **plugins** (unlike themes) each need their **own repository** — the submission form takes one repo per plugin, and the release must attach `main.js`, `manifest.json`, and `styles.css` as loose assets (not a zip). The four release-mirror repos exist, each with `README.md` (pointing back here), MIT `LICENSE`, and the plugin files at the repo root:

| Plugin id | Repository | First release |
|---|---|---|
| `tufte-sidenotes` | [PleiadesM/Tufte-Sidenote](https://github.com/PleiadesM/Tufte-Sidenote) | 1.7.0 |
| `tufte-figure-helper` | [PleiadesM/Tufte-Figure-Helper](https://github.com/PleiadesM/Tufte-Figure-Helper) | 1.7.0 |
| `tufte-inline` | [PleiadesM/Tufte-Inline](https://github.com/PleiadesM/Tufte-Inline) | 1.2.0 |
| `tufte-backlinks` | [PleiadesM/Tufte-Backlinks](https://github.com/PleiadesM/Tufte-Backlinks) | 1.0.0 |

Cutting a plugin release (every version, after the change lands in `plugins/<id>/` here):

1. Copy the plugin's files from `plugins/<id>/` to its own repo's root; commit and push.
2. Create a release whose **tag exactly matches the manifest version** (no `v` prefix):

```bash
gh release create 1.7.1 main.js manifest.json styles.css --title "Tufte Sidenotes 1.7.1" --notes "…"
```

(`tufte-inline` has no `styles.css` — its styling lives in the theme.)

3. Submit each plugin once at community.obsidian.md, same flow as the theme.
4. The plugin ids must stay stable forever once published.

The full change flow — dev vault → this repo → plugin repos — is documented in the dev vault's `CLAUDE.md` (sync discipline).

## Testing a release before announcing

1. In a **fresh vault** (not the dev vault), Settings → Appearance → Themes → the theme won't be in Browse yet — copy the two release assets into `.obsidian/themes/Tufte/` and select it.
2. Unzip the plugin assets into `.obsidian/plugins/`, enable, and walk the checklist: sidenotes in margins, figure drop modal, `[!banner]`, a Bases table + cards view, dark mode, and the bilingual CJK sample.
3. Only then submit / announce (GitHub, RedNote per the Working Document's publishing stage).
