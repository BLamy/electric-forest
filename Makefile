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

.PHONY: web-build verify-all verify-list verify-E0-T01 verify-E0-T02 verify-E0-T03 verify-E0-T04 verify-E0-T05 verify-E0-T06 verify-E0-T07 verify-E0-T08 verify-E0-T09 verify-E0-T10 verify-E0-T11 verify-E0-T12 verify-E0-T13 verify-E1-convergence verify-E1-T01 verify-E1-T02 verify-E1-T03 verify-E1-T04 verify-E1-T05 verify-E1-T06 verify-E1-T07 \
        _v-install _v-fmt _v-lint _v-typecheck _v-test _v-build _v-web _v-replay-determinism \
        _v-convergence _v-convergence-attacks _v-conformance _v-e2e _v-replay _v-meta _v-bisect-fixtures _v-bisect-sensitivity _v-bisect-critic-attacks _v-capstone _v-streamfs-patch _v-streamfs-fencing _v-streamfs-watch _v-streamfs-watch-attacks _v-streamfs-watch-sabotage

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
# reduce to byte-identical canonical state and real materialized trees (E1-T06).
_v-convergence: _v-build
	@bash tools/verify/convergence.sh

_v-convergence-attacks: _v-build
	@node tools/verify/convergence_attacks.mjs

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

_v-conformance: _v-build
	CI=true pnpm --filter @eforest/conformance verify

verify-E0-T09: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list _v-conformance
	@echo "verify-E0-T09: OK"

verify-E0-T10: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list
	@bash tools/verify/redux_replay_path_check.sh
	@node tools/verify/redux_state_check.mjs
	@node tools/verify/redux_sentinel_check.mjs
	@echo "verify-E0-T10: OK"

verify-E0-T11: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list verify-E0-T09
	@CI=true pnpm --silent exec vitest run packages/server/src/dispatch.test.ts packages/server/src/dispatch.fuzz.test.ts
	@bash tools/verify/dispatch_append_audit.sh
	@bash tools/verify/dispatch_sensitivity.sh
	@bash tools/verify/dispatch_evidence_check.sh
	@echo "verify-E0-T11: OK"

_v-bisect-fixtures: _v-build
	@set -eu; \
	fixture_root=.eforest/tasks/epic-0-the-seed/E0-T12-ef-bisect/evidence/fixtures; \
	work=.eforest/tasks/epic-0-the-seed/E0-T12-ef-bisect/work; \
	mkdir -p "$$work"; \
	count=0; \
	for expected in "$$fixture_root"/*/pair.expected.json; do \
		dir="$${expected%/pair.expected.json}"; \
		count=$$((count + 1)); \
		output="$$work/bisect-$$count.json"; \
		echo "RUN CI=true pnpm --silent ef bisect $$dir/a.jsonl $$dir/b.jsonl"; \
		if CI=true pnpm --silent ef bisect "$$dir/a.jsonl" "$$dir/b.jsonl" >"$$output"; then actual=0; else actual=$$?; fi; \
		if grep -q '"kind":"identical"' "$$expected"; then required=0; else required=1; fi; \
		[ "$$actual" -eq "$$required" ] || { echo "FAIL $$dir: exit $$actual (expected $$required)" >&2; exit 1; }; \
		cmp "$$output" "$$expected" || { echo "FAIL $$dir: stdout differs" >&2; exit 1; }; \
		echo "PASS $${dir##*/}"; \
		rm -f "$$output"; \
	done; \
	committed=$$(find "$$fixture_root" -mindepth 2 -maxdepth 2 -name pair.expected.json -type f | wc -l | tr -d ' '); \
	[ "$$count" -eq "$$committed" ] || { echo "FAIL fixture invocation count $$count != $$committed" >&2; exit 1; }; \
	echo "_v-bisect-fixtures: $$count real process invocations OK"

_v-bisect-sensitivity: _v-build
	@bash tools/verify/bisect_sensitivity.sh

_v-bisect-critic-attacks: _v-build
	@node tools/verify/bisect_critic_attacks.mjs

verify-E0-T12: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list _v-bisect-fixtures _v-bisect-sensitivity _v-bisect-critic-attacks
	@echo "verify-E0-T12: OK"

_v-capstone: _v-build
	@EF_CAPSTONE_EVIDENCE_DIR=.eforest/tasks/epic-0-the-seed/E0-T13-two-terminals-one-log/evidence bash tools/verify/e0-capstone/run.sh

verify-E0-T13: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list _v-capstone
	@echo "verify-E0-T13: OK"

_v-streamfs-golden: _v-build
	@node tools/verify/streamfs_golden.mjs

_v-streamfs-dirs: _v-build
	@node tools/verify/streamfs_dirs.mjs

_v-streamfs-refusals: _v-build
	@node tools/verify/streamfs_refusal_corpus.mjs

_v-streamfs-directory-refusals: _v-build
	@node tools/verify/streamfs_directory_refusal_corpus.mjs

_v-streamfs-append: _v-build
	@bash tools/verify/streamfs_append_audit.sh

_v-streamfs-purity: _v-build
	@bash tools/verify/streamfs_purity.sh

_v-streamfs-patch: _v-build
	@node tools/verify/patch_parity.mjs

_v-streamfs-fencing: _v-build
	@node tools/verify/streamfs_fencing.mjs

_v-streamfs-watch: _v-build
	@node tools/verify/streamfs_watch.mjs

_v-streamfs-watch-attacks: _v-build
	@node tools/verify/streamfs_watch_attacks.mjs

_v-streamfs-watch-sabotage: _v-build
	@node tools/verify/streamfs_watch_sabotage.mjs

_v-snapshot: _v-build
	@node tools/verify/snapshot.mjs
	@CI=true pnpm --silent exec vitest run packages/streamfs/test/snapshot.test.ts

verify-E1-T01: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list _v-streamfs-golden _v-streamfs-refusals _v-streamfs-append _v-streamfs-purity
	@echo "verify-E1-T01: OK"

verify-E1-T02: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list verify-E1-T01 _v-streamfs-dirs _v-streamfs-directory-refusals _v-streamfs-append _v-streamfs-purity
	@echo "verify-E1-T02: OK"

verify-E1-T03: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list verify-E1-T02 _v-streamfs-patch
	@echo "verify-E1-T03: OK"

verify-E1-T04: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list verify-E1-T03 _v-streamfs-fencing
	@CI=true pnpm --silent exec vitest run packages/streamfs/test/fencing.test.ts packages/streamfs/test/fencing.two-writer.test.ts
	@echo "verify-E1-T04: OK"

verify-E1-T05: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list verify-E1-T04 _v-streamfs-watch _v-streamfs-watch-attacks _v-streamfs-watch-sabotage
	@CI=true pnpm --silent exec vitest run packages/streamfs/test/watch.test.ts
	@echo "verify-E1-T05: OK"

verify-E1-convergence: _v-build _v-convergence
	@echo "verify-E1-convergence: OK"

verify-E1-T06: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list verify-E1-T05 _v-convergence _v-convergence-attacks
	@CI=true pnpm --silent exec vitest run packages/cli/src/materialize.test.ts
	@echo "verify-E1-T06: OK"

verify-E1-T07: _v-fmt _v-lint _v-typecheck _v-test _v-build _v-meta verify-list verify-E1-T06 _v-conformance _v-snapshot
	@echo "verify-E1-T07: OK"

verify-all: verify-E0-T01 verify-E0-T02 verify-E0-T03 verify-E0-T04 verify-E0-T05 verify-E0-T06 verify-E0-T07 verify-E0-T08 verify-E0-T09 verify-E0-T10 verify-E0-T11 verify-E0-T12 verify-E0-T13 verify-E1-T01 verify-E1-T02 verify-E1-T03 verify-E1-T04 verify-E1-T05 verify-E1-T06 verify-E1-T07
	@echo "verify-all: every defined verify target passed"

verify-list:
	@bash tools/verify/list.sh

# --- end verify section ---
