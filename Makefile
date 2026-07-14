# electric-forest verification entrypoints. Durable Streams protocol behavior is
# supplied by Electric's published packages; this repo verifies only its adapters,
# application event model, replay tooling, and StreamFS product behavior.

# --- Adversarial-verification tooling ---

.PHONY: verify-all verify-list \
	verify-E0-T01 verify-E0-T02 verify-E0-T03 verify-E0-T04 verify-E0-T05 \
	verify-E0-T06 verify-E0-T07 verify-E0-T08 verify-E0-T09 verify-E0-T10 \
	verify-E0-T11 verify-E0-T12 verify-E0-T13 verify-E1-T01 verify-E1-T02 \
	verify-E1-T03 verify-E1-T04 verify-E1-T05 verify-E1-T06 verify-E1-T07 \
	verify-E1-T08 verify-E1-T09 verify-E1-T10 _v-install _v-fmt _v-lint _v-typecheck \
	_v-test _v-build _v-gates _v-official-streamfs _v-e1-t10-evidence _v-meta verify-task-board

_v-install:
	@if [ ! -d node_modules ]; then CI=true pnpm install --frozen-lockfile; else echo "dependencies: present"; fi

_v-fmt: _v-install
	@CI=true pnpm format:check

_v-lint: _v-install
	@CI=true pnpm lint

_v-typecheck: _v-install
	@CI=true pnpm typecheck

_v-test: _v-install
	@CI=true pnpm test

_v-build: _v-install
	@CI=true pnpm build

_v-gates: _v-fmt _v-lint _v-typecheck _v-test _v-build

_v-official-streamfs: _v-build
	@CI=true EFOREST_TEST_PREBUILT=1 pnpm exec vitest run packages/cli/src/official.integration.test.ts packages/streamfs/test/domain.test.ts packages/streamfs/test/patch.property.test.ts packages/streamfs/test/durable-streams.integration.test.ts packages/streamfs/test/three-way-merge.test.ts packages/streamfs/test/three-way-merge.integration.test.ts packages/streamfs/test/three-way-merge-adversarial.integration.test.ts packages/streamfs/test/three-way-merge-identity-boundaries.integration.test.ts packages/streamfs/test/verify-task-workflow.test.ts

_v-e1-t10-evidence: _v-build
	@node tools/verify/e1_t10_evidence.mjs

_v-meta:
	@bash tools/verify/self_check.sh

verify-E0-T01: _v-gates
	@echo "verify-E0-T01: OK"
verify-E0-T02: _v-meta verify-list verify-task-board
	@echo "verify-E0-T02: OK"
verify-E0-T03: _v-gates _v-meta verify-list
	@echo "verify-E0-T03: OK"
verify-E0-T04: _v-gates _v-meta verify-list
	@echo "verify-E0-T04: OK"
verify-E0-T05: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E0-T05: OK"
verify-E0-T06: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E0-T06: OK"
verify-E0-T07: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E0-T07: OK"
verify-E0-T08: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E0-T08: OK"
verify-E0-T09: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E0-T09: OK"
verify-E0-T10: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E0-T10: OK"
verify-E0-T11: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E0-T11: OK"
verify-E0-T12: _v-gates _v-meta verify-list
	@echo "verify-E0-T12: OK"
verify-E0-T13: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E0-T13: OK"

verify-E1-T01: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E1-T01: OK"
verify-E1-T02: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E1-T02: OK"
verify-E1-T03: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E1-T03: OK"
verify-E1-T04: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E1-T04: OK"
verify-E1-T05: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E1-T05: OK"
verify-E1-T06: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E1-T06: OK"
verify-E1-T07: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E1-T07: OK"
verify-E1-T08: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E1-T08: OK"
verify-E1-T09: _v-gates _v-official-streamfs _v-meta verify-list
	@echo "verify-E1-T09: OK"
verify-E1-T10: _v-gates _v-official-streamfs _v-e1-t10-evidence _v-meta verify-list
	@echo "verify-E1-T10: OK"

verify-all: verify-E0-T01 verify-E0-T02 verify-E0-T03 verify-E0-T04 verify-E0-T05 verify-E0-T06 verify-E0-T07 verify-E0-T08 verify-E0-T09 verify-E0-T10 verify-E0-T11 verify-E0-T12 verify-E0-T13 verify-E1-T01 verify-E1-T02 verify-E1-T03 verify-E1-T04 verify-E1-T05 verify-E1-T06 verify-E1-T07 verify-E1-T08 verify-E1-T09 verify-E1-T10
	@echo "verify-all: every defined verify target passed"

verify-list:
	@bash tools/verify/list.sh

verify-task-board:
	@pnpm task-board:check

# --- end verify section ---
