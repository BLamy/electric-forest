---
name: run-electric-forest
description: Build, start, run, log in to, and screenshot the electric-forest web app locally (streams server + emulated Auth0 + platform + web bundle, with seeded maple/reading-room data). Use when asked to run/start/launch the app, see a UI change in the real app, or take screenshots of repo/PR/issues/wiki pages.
---

# Run electric-forest

All paths are relative to the repo root. There is no `pnpm dev`: the web app is a static
Vite bundle served by the platform process, which needs a Durable Streams server and an
OIDC issuer. The one-process way to get all of it, seeded with data, is the E5-T14 preview
fixture. Drive it with `driver.mjs` (playwright-core + system Chrome), which logs in
through the emulated Auth0 and screenshots whatever paths you give it.

## Prerequisites

- Node 22+ (verified on 24.20), pnpm 10.15 via corepack (`corepack enable`), deps installed
  (`pnpm install --frozen-lockfile`), `vendor/emulate` submodule checked out.
- Google Chrome at `/Applications/Google Chrome.app` (macOS). Elsewhere set
  `CHROME_PATH=/path/to/chrome`. playwright-core ships no browser.

## Build

The fixture imports `packages/*/dist` and the platform serves `apps/web/dist`, so rebuild
after **any** source change, or you'll be looking at an old bundle:

```sh
pnpm build
```

(~1 min; the "chunks larger than 500 kB" warning is normal.)

## Run (agent path)

1. Start the stack in the background, teeing to a log:

   ```sh
   node --env-file-if-exists=.env apps/web/test/fixtures/e5-t14-preview-server.mjs 2>&1 | tee "$LOG"
   ```

   Run it with `run_in_background`. Wait for the ready line (takes a few seconds):

   ```sh
   for i in $(seq 1 60); do grep -q E5_T14_READY "$LOG" && break; sleep 1; done; cat "$LOG"
   ```

   It prints `E5_T14_READY {"url":"http://127.0.0.1:<port>", "repoUrl":..., "prUrl":..., "subject":"brett@electric-forest.test", ...}`.
   Ports are random every start.

2. Log in and screenshot paths:

   ```sh
   node .claude/skills/run-electric-forest/driver.mjs --log "$LOG" --out "$SHOTS" \
     / /maple/reading-room /orgs/maple/repos/reading-room/pulls
   ```

   Flags: `--url <platform url>` instead of `--log`; `--wait <ms>` max per page to wait out the "Loading route…" placeholder (default 30000);
   `--email <user>` to pick a different emulated account. Prints `path -> final url "title" file`
   per page and any `pageerror`s. **Read the PNGs.** A final URL on `:<port+1>/authorize` means
   the login didn't take.

3. Stop: kill the background task (SIGINT/SIGTERM shuts the world down). All state is
   in-memory, so every restart reseeds from scratch.

Seeded routes worth hitting: `/` (personal account "brett", 0 repos), `/maple/reading-room`
(code), `/maple/reading-room/blob/main/README.md`, `/orgs/maple/repos/reading-room/pulls`
(5 PRs, `/pulls/60` is the detail), `.../issues`, `.../wiki/home`.

## Run (human path)

Same step 1, then open the printed `url` in a browser, go to `/auth/login`, and click
**Brett Lamy (brett@electric-forest.test)**. No password to type.

## Gotchas

- **Agent replies read `.env`** (gitignored): `EF_AGENT_RESPONDER=harness` runs each @mentioned
  agent through its harness CLI — `claude -p` (auth: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`,
  or the local Claude Code login) or `codex exec` (the local Codex login). Never the model API
  directly: a setup-token got `429 rate_limit_error` on every raw Messages API call. Replies take
  ~10–60s; a failed run posts a ⚠️ reply in the thread saying why.
- **`/` is public.** Hitting it without a session does *not* redirect to login, so a driver
  that waits for a redirect from `/` never logs in and every later app route bounces
  to `/authorize`. Start login at `/auth/login` (the driver does).
- **The emulated Auth0 login page is a button picker**, not an email/password form. It lists
  `testuser@auth0.local` first. Click the button whose text contains the subject's email.
- **Never `waitForLoadState("networkidle")`.** Live stream subscriptions keep the network busy;
  it times out at 30s. Wait on page content instead.
- **The repo Code page shows "Loading route…" for a long time on a cold start** (big lazy
  chunk: Markdown/mermaid/shiki). A fixed 3s or even 8s wait still screenshotted the placeholder,
  so the driver waits for that text to detach instead. Expect ~45s for the default three-page run.
- **The personal page shows "No repositories yet".** Seeded repos belong to the `maple`
  org ("M" in the left rail), not to brett.
- `pnpm server:serve` (what `docs/getting-started.md` says) only starts the bare streams
  server on :4321. No web UI, no auth. The platform bin (`packages/platform/dist/src/bin.js`)
  needs `EF_OIDC_ISSUER`, `EF_OIDC_CLIENT_ID`, `EF_SESSION_SECRET`, `EF_SESSION_TTL`,
  `EFOREST_SERVER_URL`, plus a running Auth0 emulator. Use the fixture instead.
- The fixture writes scratch under
  `.eforest/tasks/epic-5-the-meadow/E5-T14-visual-product-capstone/work/` (gitignored).
- Put `$LOG`/`$SHOTS` in your scratchpad or the task's `work/` dir, not the repo root.

## Test

Build gates (see CLAUDE.md): `pnpm format:check && pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm build`. Existing browser specs (`apps/web/test/*.pw.ts`) boot this same fixture.
