# electric-forest Makefile — currently the adversarial-verification skeleton (lands fully
# with Epic 0's verify-spine task). There is no pnpm workspace yet (E0-T01) and no web app
# yet, so most shared recipes guard at RUNTIME on what actually exists (package.json,
# packages/*, apps/web/*) and SKIP LOUDLY when their infra hasn't landed:
# `SKIPPED: <reason>` + nonzero exit unless VERIFY_ALLOW_SKIP=1. Nothing in this file is
# allowed to fake a pass — a recipe either really runs, or skips loudly, or (guard
# satisfied but check not yet wired) fails red.
# tools/verify/self_check.sh polices the verify section below; run it after editing.

# --- Adversarial-verification tooling ---
# Each `verify-E<n>-T<nn>` target runs that task's acceptance checks mechanically and
# exits NONZERO on any failure, composed from the shared _v-* recipes below (contract
# frozen by Epic 0's verify-spine task: later tasks compose these by name). `verify-all`
# runs the union once; `verify-list` maps targets↔tasks and fails if any implemented/
# verified task lacks a target. Missing tools or not-yet-landed infra SKIP loudly and
# exit nonzero unless VERIFY_ALLOW_SKIP=1 — silence is forbidden (AGENTS.md).
# tools/verify/self_check.sh scans everything between these marker comments (comments
# stripped) for green-washing escapes; keep it clean.

.PHONY: web-build verify-all verify-list verify-E0-T01 verify-E0-T02 verify-E0-T03 verify-E0-T04 verify-E0-T05 verify-E0-T06 verify-E0-T07 verify-E0-T08 verify-E0-T10 \
        _v-install _v-fmt _v-lint _v-typecheck _v-test _v-build _v-web _v-replay-determinism \
        _v-convergence _v-e2e _v-replay _v-meta

# skip helper: $(call v_skip,<reason>) — the loud-skip contract. Prints and exits
# nonzero; VERIFY_ALLOW_SKIP=1 makes the skip non-fatal but still printed.
v_skip = echo "SKIPPED: $(1)"; [ "$(VERIFY_ALLOW_SKIP)" = "1" ] || exit 1

# Placeholder: the web app lands in Epic 3 (browse). Until then this target skips loudly;
# if apps/web/package.json appears without this recipe being wired, it fails red rather
# than pretending. It lives INSIDE the marker section because _v-web invokes it —
# self_check.sh must police it.
web-build:
	@if [ -f apps/web/package.json ]; then \
	  echo "web-build: apps/web exists but the real build is not wired here yet — refusing to fake a pass" >&2; exit 1; \
	else $(call v_skip,web app lands in Epic 3); fi

# ── TypeScript gates — real commands once the workspace lands (E0-T01) ────────
_v-install:
	@if [ ! -f package.json ]; then $(call v_skip,no package.json yet (E0-T01)); \
	elif [ ! -d node_modules ]; then CI=true pnpm install --frozen-lockfile; \
	else echo "_v-install: node_modules present"; fi

_v-fmt: _v-install
	@if [ -f package.json ]; then CI=true pnpm format:check; \
	else $(call v_skip,no package.json yet (E0-T01)); fi

_v-lint: _v-install
	@if [ -f package.json ]; then CI=true pnpm lint; \
	else $(call v_skip,no package.json yet (E0-T01)); fi

_v-typecheck: _v-install
	@if [ -f package.json ]; then CI=true pnpm typecheck; \
	else $(call v_skip,no package.json yet (E0-T01)); fi

_v-test: _v-install
	@if [ -f package.json ]; then CI=true pnpm test; \
	else $(call v_skip,no package.json yet (E0-T01)); fi

_v-build: _v-install
	@if [ -f package.json ]; then CI=true pnpm build; \
	else $(call v_skip,no package.json yet (E0-T01)); fi

# ── web / evidence gates ─────────────────────────────────────────────────────
_v-web:
	@if [ ! -f apps/web/package.json ]; then $(call v_skip,web app lands in Epic 3); \
	elif ! command -v pnpm >/dev/null 2>&1; then $(call v_skip,pnpm not installed); \
	else $(MAKE) --no-print-directory web-build; fi

# Replay determinism: the same canonical event log replayed twice → identical state
# digests (the stream-layer evidence gate). Wired when `ef replay` exists (Epic 0);
# until then the guard skips, and if the tool appears before the check is wired this
# fails red rather than pretending.
_v-replay-determinism: _v-build
	@mkdir -p .eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest/work
	CI=true pnpm --silent ef replay .eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest/evidence/golden.jsonl --digest > .eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest/work/run-1.digest
	CI=true pnpm --silent ef replay .eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest/evidence/golden.jsonl --digest > .eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest/work/run-2.digest
	@cmp .eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest/work/run-1.digest .eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest/work/run-2.digest
	@cmp .eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest/work/run-1.digest .eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest/evidence/golden.digest
	@echo "_v-replay-determinism: $$(cat .eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest/work/run-1.digest) OK"

# Two-client convergence: two independent clients driven through the same branch stream
# must reduce to byte-identical canonical state (lands with stream-fs in Epic 1).
_v-convergence:
	@if [ ! -f package.json ]; then $(call v_skip,no package.json yet (E0-T01)); \
	elif [ ! -d packages/streamfs ]; then $(call v_skip,convergence harness lands in Epic 1); \
	else echo "_v-convergence: packages/streamfs exists but the convergence diff is not wired here yet — refusing to fake a pass" >&2; exit 1; fi

# Headless Playwright happy path: zero console errors + DOM-exposed offsets/digests
# match committed expectations (lands with the web app in Epic 3).
_v-e2e:
	@if [ ! -f apps/web/package.json ]; then $(call v_skip,no web app yet (Epic 3)); \
	elif ! command -v pnpm >/dev/null 2>&1; then $(call v_skip,pnpm not installed); \
	else echo "_v-e2e: the Playwright smoke suite is not wired here yet — refusing to fake a pass" >&2; exit 1; fi

# Record the final happy run as an uploaded Replay recording (the browser evidence
# layer). Gated on tools/replay/preflight.sh — where the Replay runtime is absent, this
# skips LOUDLY and the claim carries 'Replay: N/A (<reason>) + mitigation' per AGENTS.md.
_v-replay:
	@if [ ! -f apps/web/package.json ]; then $(call v_skip,nothing to record yet — web app lands in Epic 3); \
	elif ! bash tools/replay/preflight.sh; then $(call v_skip,replay preflight failed — see its output; fall back to Playwright + declare 'Replay: N/A' per AGENTS.md); \
	else bash tools/replay/record-run.sh -o verify-run; fi

# Meta: the critic verifies itself. Works TODAY — self_check.sh needs only this
# Makefile, the task tree, and the tools/verify scripts.
_v-meta:
	@bash tools/verify/self_check.sh

# ── per-task targets ─────────────────────────────────────────────────────────
# Added as tasks reach implemented, one per task folder, composed from the recipes above:
#   verify-E0-T01: _v-fmt _v-lint _v-typecheck _v-test _v-build ; @echo "verify-E0-T01: OK"
# Every new target also joins verify-all's prerequisites. self_check.sh and list.sh
# enforce the coverage rule from the moment a status flips.

verify-E0-T01: _v-fmt _v-lint _v-typecheck _v-test _v-build
	@echo "verify-E0-T01: OK"

verify-E0-T02: _v-meta verify-list
	@bash tools/verify/self_check_sensitivity.sh
	@echo "verify-E0-T02: OK"

verify-E0-T03: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list
	@bash tools/verify/replay_goldens.sh
	@echo "verify-E0-T03: OK"

verify-E0-T04: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-replay-determinism _v-meta verify-list
	@echo "verify-E0-T04: OK"

verify-E0-T05: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list
	@bash tools/verify/replay_transcript.sh
	@bash tools/verify/transcript_sensitivity.sh
	@bash tools/verify/check_all_races.sh
	@node tools/verify/adversarial_E0_T05.mjs
	@node tools/verify/independent_race_E0_T05.mjs
	@bash tools/verify/sabotage_E0_T05.sh
	@bash tools/verify/no_reimpl_grep.sh
	@echo "verify-E0-T05: OK"

verify-E0-T06: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list
	@node tools/verify/live_convergence_E0_T06.mjs
	@echo "verify-E0-T06: OK"

verify-E0-T07: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list
	@node tools/verify/restart_file_store_E0_T07.mjs .eforest/tasks/epic-0-the-seed/E0-T07-file-backed-store/evidence
	@node tools/verify/torn_file_store_E0_T07.mjs .eforest/tasks/epic-0-the-seed/E0-T07-file-backed-store/evidence/e0-t07-torn-transcript.json
	@node tools/verify/store_differential_E0_T07.mjs .eforest/tasks/epic-0-the-seed/E0-T07-file-backed-store/evidence/e0-t07-differential.json
	@echo "verify-E0-T07: OK"

verify-E0-T08: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list
	@node tools/verify/client_E0_T08.mjs
	@echo "verify-E0-T08: OK"

verify-E0-T10: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list
	@bash tools/verify/redux_replay_path_check.sh
	@node tools/verify/redux_state_check.mjs
	@node tools/verify/redux_sentinel_check.mjs
	@echo "verify-E0-T10: OK"

verify-all: verify-E0-T01 verify-E0-T02 verify-E0-T03 verify-E0-T04 verify-E0-T05 verify-E0-T06 verify-E0-T07 verify-E0-T08 verify-E0-T10
	@echo "verify-all: every defined verify target passed"

verify-list:
	@bash tools/verify/list.sh

# --- end verify section ---
