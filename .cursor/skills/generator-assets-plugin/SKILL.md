---
name: generator-assets-plugin
description: Navigate the generator-assets Photoshop Generator plugin—layer name parsing (PEG), render pipeline, asset managers, and where to change behavior. Use when editing rendering, layer names, SVG/pixmap output, or plugin init.
---

# Working in generator-assets

This repo is a **Generator plug-in** (not a standalone app). There is no server to start; behavior is loaded by Photoshop’s Generator framework.

## Where things live

| Area | Location | Notes |
|------|----------|--------|
| Plugin entry / lifecycle | `main.js` | `init()` wires `DocumentManager`, `StateManager`, `RenderManager`; asset generation starts when the plugin is enabled. |
| Layer name → components | `lib/parser.js` (generated) | Built from `etc/layernames.pegjs` via **`grunt build`**. Edit the **`.pegjs`** file, then rebuild. |
| Async rendering queue | `lib/rendermanager.js` | Schedules jobs, talks to renderers. |
| Actual SVG / pixmap output | `lib/renderer.js` and related | `render()` flows for components. |
| Per-layer asset assembly | `lib/assetmanager.js` | Components from parsed layer names, errors. |

## PEG / parser changes

1. Change grammar in `etc/layernames.pegjs`.
2. Run **`grunt build`** so `lib/parser.js` stays in sync (pre-built copy may exist; still regenerate after grammar edits).
3. Run targeted tests that cover parsing if you changed syntax (see project test layout under `test/`).

## Automation vs this skill

- **GitHub issue → Cloud Agents:** `.github/workflows/issue-opened.yml` and **`AGENTS.md`** (do not duplicate here).
- **This skill:** orientation inside the **JavaScript plugin** codebase when you implement or review features locally.

## Quick mental model

1. User enables asset generation → `StateManager` enables pipeline.  
2. Documents / layers update → names parsed → components created.  
3. `RenderManager` queues renders → `renderer` produces files.

Use this skill when the task is **inside the plugin** (parsing, rendering, assets), not when the task is **only** about CI or issue labels.
