# v1 — root HTML builds (frozen reference)

The root `index.html` and `clearrate-main/` are frozen. Do not touch them; all work is in `app-v2/`.

## Overview
ClearRate is a payment-processing proposal engine for AIO Payments. A sales rep uploads a merchant's current processing statement (PDF or image), Claude extracts the fees/volume/effective-rate, the app computes a competing AIO offer against AIO's margin floors, generates a branded proposal, and kicks off an Adyen merchant-onboarding application.

## Tech Stack
- **Language:** JavaScript (JSX transpiled in-browser via `@babel/standalone`)
- **UI:** React 18 + ReactDOM (UMD builds from `unpkg.com`), inline-style components (no CSS framework)
- **PDF export:** `html2pdf.js` 0.10.1 (from cdnjs) — only in `clearrate-main/index.html`
- **AI:** Anthropic Claude Messages API called directly from the browser (`https://api.anthropic.com/v1/messages`, header `anthropic-dangerous-direct-browser-access: true`). Models: `claude-sonnet-4-6` (root build) and `claude-sonnet-4-20250514` (clearrate-main build).
- **Payments onboarding:** Adyen LEM / Management / Balance Platform REST APIs, proxied through a CORS proxy (default `https://corsproxy.io/?`) — `clearrate-main/index.html` only.
- **Persistence:** `localStorage` only. No package manifest, no `node_modules`, no bundler.

## Architecture
Two parallel versions of the same app live in the repo:

- **`index.html` (root)** — older/simpler build. 4-step flow: `upload → analysis → pricing → proposal`. Has a `settings` page with processors + users.
- **`clearrate-main/`** — newer build, three cooperating pages:
  - `index.html` — the internal proposal engine. 5-step flow: `upload → analysis → pricing → proposal → apply`. Adds AIO margin tables, PDF export, and the Adyen onboarding "Apply" step. Saves submissions to `localStorage["aio_applications"]`.
  - `customer.html` — public-facing "Free Processing Analysis" lead-capture page (light theme). Customer uploads a statement; results + contact info are written to `localStorage["aio_submissions"]`.
  - `admin.html` — password-gated dashboard (dark theme) that reads `localStorage["aio_submissions"]` to review leads. Password is hardcoded as `aio2024` (`ADMIN_PASSWORD`).

Note: `localStorage` is per-origin, so `customer.html` and `admin.html` only share `aio_submissions` data when served from the same origin/host.

## Core pipeline (per page)
1. **Upload** — `FileReader.readAsDataURL` turns the statement into base64; sent to Claude as an `image` or `document` (PDF) content block.
2. **Analysis** — Claude returns strict JSON (merchant name, volume, fees, effective rate, card-present vs not-present splits, current pricing model, etc.). `parseJSON()` strips markdown fences and slices to the outer `{…}`.
3. **Pricing** — computed locally. `MARGIN_REQS` / `getMarginFloor(volume)` enforce AIO's tiered take-rate + minimum MRR floors. `INTERCHANGE_SCHEDULE` (root build) estimates true interchange for hidden-margin tiered statements. `calcAdyenCost` / `adyenRateOnVolume` model the AIO/Adyen cost basis.
4. **Proposal** — Claude generates proposal copy using the *already-computed* numbers (prompt explicitly forbids recalculating). Exported via `html2pdf` (clearrate-main).
5. **Apply** (clearrate-main only) — collects business/owner details and optionally calls Adyen LEM/Management APIs to create legal entities, ownership relationships, and onboarding.

## Key Files & Entry Points
- `/Users/shaheerhasnain/Documents/Projects - AIO/aioratecalc/index.html` — standalone older build (open directly in a browser).
- `/Users/shaheerhasnain/Documents/Projects - AIO/aioratecalc/clearrate-main/index.html` — main internal proposal + apply app.
- `/Users/shaheerhasnain/Documents/Projects - AIO/aioratecalc/clearrate-main/customer.html` — public lead-capture analysis page.
- `/Users/shaheerhasnain/Documents/Projects - AIO/aioratecalc/clearrate-main/admin.html` — admin dashboard for reviewing submissions.

There is no README, no `package.json`, and no source directory — each HTML file is the complete, self-contained application.

## Build / Run / Test
There is **no build, install, or test tooling** in this repo (no `package.json`, no scripts, no test files).

- **Run:** open any of the `.html` files directly in a browser, or serve the folder over a static server, e.g.:
  ```
  cd "/Users/shaheerhasnain/Documents/Projects - AIO/aioratecalc"
  python3 -m http.server 8000
  ```
  then visit `http://localhost:8000/index.html` or `http://localhost:8000/clearrate-main/index.html`.
- **API key:** root `index.html` `prompt()`s for an Anthropic API key on first load and stores it in `localStorage["cr_api_key"]`. The `clearrate-main` pages only *read* `cr_api_key` from `localStorage` — set it manually (e.g. via the root page or DevTools) before they can call Claude.
- **Test:** none. Verification is manual, by running the flow in a browser.

## Conventions & Gotchas
- **Secrets in the browser.** The Anthropic API key and all Adyen API keys (`lemApiKey`, `managementApiKey`, `balancePlatformApiKey`) are stored in `localStorage` and sent from the client. The code itself warns this is unsafe for live/production keys (see the security note in `clearrate-main/index.html`). The admin password `aio2024` is hardcoded in `admin.html`.
- **No server.** All "backend" state is `localStorage`. Keys in use: `cr_api_key`, `clearrate:settings`, `clearrate:adyen_config`, `aio_applications`, `aio_submissions`.
- **Two diverging copies.** Root `index.html` and `clearrate-main/index.html` share most logic but differ (Claude model id, the `apply`/Adyen step, `MARGIN_REQS`, PDF export, a `users` array in settings). Changes to shared logic must be made in both if you want parity.
- **Model ids differ between builds** — `claude-sonnet-4-6` vs `claude-sonnet-4-20250514`. Keep this in mind when editing prompts/models.
- **Pricing is computed locally, not by the LLM.** Claude is used only for statement extraction and proposal prose; it is explicitly instructed not to change numbers. Keep money math in JS (`MARGIN_REQS`, `getMarginFloor`, `calcAdyenCost`, `INTERCHANGE_SCHEDULE`).
- **LLM JSON parsing is defensive** via `parseJSON()` (strips ```` ```json ```` fences, slices outer braces). Preserve that when changing prompts.
- **CDN-dependent.** React, Babel, and html2pdf load from public CDNs at runtime, so the app needs internet access to run at all. JSX is transpiled on every page load via `<script type="text/babel">` (slow first paint; not a production setup).
- **Adyen calls go through a public CORS proxy** (`corsproxy.io` by default, configurable via `clearrate:adyen_config.corsProxy`).
- `.gitignore` lists `node_modules/`, `.env`, `__pycache__/`, etc. — generic boilerplate; none of those toolchains are actually present.
