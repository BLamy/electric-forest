# electric-forest verification entrypoints. Durable Streams protocol behavior is
# supplied by Electric's published packages; this repo verifies only its adapters,
# application event model, replay tooling, and StreamFS product behavior.

# --- Adversarial-verification tooling ---

.PHONY: verify-all verify-list \
	verify-E0-T01 verify-E0-T02 verify-E0-T03 verify-E0-T04 verify-E0-T05 \
	verify-E0-T06 verify-E0-T07 verify-E0-T08 verify-E0-T09 verify-E0-T10 \
	verify-E0-T11 verify-E0-T12 verify-E0-T13 verify-E1-T01 verify-E1-T02 \
	verify-E1-T03 verify-E1-T04 verify-E1-T05 verify-E1-T06 verify-E1-T07 \
	verify-E1-T08 verify-E1-T09 verify-E1-T10 verify-E1-T11 verify-E2-T01 verify-E2-T02 _v-install _v-fmt _v-lint \
	_v-typecheck _v-test _v-build _v-gates _v-official-streamfs _v-e1-t10-evidence \
	_v-e1-t11-capstone _v-e1-t11-causality _v-e1-t11-external _v-e1-t11-journal _v-e1-t11-sabotage \
	_v-replay-determinism _v-e2-t01-identity _v-e2-t02-auth0 _v-e2-t02-browser _v-meta verify-task-board

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
	@CI=true pnpm exec tsc -b tsconfig.build.json --clean
	@if [ -f packages/identity/tsconfig.build.json ]; then CI=true pnpm --filter @eforest/identity exec tsc -b tsconfig.build.json --clean; fi
	@CI=true pnpm build

_v-gates: _v-fmt _v-lint _v-typecheck _v-test _v-build

_v-official-streamfs: _v-build
	@CI=true EFOREST_TEST_PREBUILT=1 pnpm exec vitest run packages/cli/src/official.integration.test.ts packages/streamfs/test/domain.test.ts packages/streamfs/test/patch.property.test.ts packages/streamfs/test/durable-streams.integration.test.ts packages/streamfs/test/three-way-merge.test.ts packages/streamfs/test/three-way-merge.integration.test.ts packages/streamfs/test/three-way-merge-adversarial.integration.test.ts packages/streamfs/test/three-way-merge-identity-boundaries.integration.test.ts packages/streamfs/test/verify-task-workflow.test.ts

_v-e1-t10-evidence: _v-build
	@node tools/verify/e1_t10_evidence.mjs

_v-e1-t11-capstone: _v-build
	@node tools/verify/e1_capstone.mjs

_v-e1-t11-causality: _v-build
	@node tools/verify/e1_content_causality.mjs

_v-e1-t11-external: _v-build
	@node tools/verify/e1_capstone_external.mjs

_v-e1-t11-journal: _v-build
	@node tools/verify/e1_capstone_journal_test.mjs

_v-e1-t11-sabotage: _v-build
	@node tools/verify/e1_capstone_sabotage.mjs

_v-replay-determinism: _v-build
	@bash tools/verify/replay_goldens.sh

_v-e2-t01-identity: _v-build
	@! grep -rnE --exclude='*.test.ts' "Math\\.random|\\bnew Date\\b|Date\\.now|performance\\.now|hrtime|setTimeout|setInterval|crypto\\.(getRandomValues|randomUUID|randomBytes)|process\\.env|(from ['\"]|require\\(['\"]|import\\(['\"])(node:)?(fs|net|http|https|child_process)['\"/]?" packages/identity/src
	@node packages/identity/scripts/verify-golden.mjs
	@node packages/identity/scripts/verify-provenance-refresh.mjs
	@node packages/identity/scripts/verify-provenance-refresh-sensitivity.mjs

# The E2-T02 target-specific environment is exported to every prerequisite, so the
# root gates, upstream build/tests, harness, and browser proof all inherit the same
# blackholed proxy boundary. Lowercase aliases cover clients that ignore uppercase.
verify-E2-T02 _v-e2-t02-auth0 _v-e2-t02-browser: export HTTP_PROXY := http://127.0.0.1:1
verify-E2-T02 _v-e2-t02-auth0 _v-e2-t02-browser: export HTTPS_PROXY := http://127.0.0.1:1
verify-E2-T02 _v-e2-t02-auth0 _v-e2-t02-browser: export NO_PROXY := 127.0.0.1,localhost,::1
verify-E2-T02 _v-e2-t02-auth0 _v-e2-t02-browser: export http_proxy := http://127.0.0.1:1
verify-E2-T02 _v-e2-t02-auth0 _v-e2-t02-browser: export https_proxy := http://127.0.0.1:1
verify-E2-T02 _v-e2-t02-auth0 _v-e2-t02-browser: export no_proxy := 127.0.0.1,localhost,::1

_v-e2-t02-auth0:
	@if [ ! -e vendor/emulate/.git ]; then git submodule update --init --recursive vendor/emulate; fi
	@test "$$(git -C vendor/emulate rev-parse HEAD)" = "119fe2d0cc1397d616bd60abd9a77b98f8a95a62"
	@CI=true corepack pnpm@11.2.2 --pm-on-fail=ignore --dir vendor/emulate install --frozen-lockfile
	@CI=true corepack pnpm@11.2.2 --pm-on-fail=ignore --dir vendor/emulate exec turbo build --filter=emulate
	@CI=true corepack pnpm@11.2.2 --pm-on-fail=ignore --dir vendor/emulate --filter @emulators/auth0 test
	@node tools/verify/e2_t02_auth0.mjs
	@! git grep -n -E 'vendor/emulate|@emulators/auth0' -- 'packages/*/src' 'apps/*/src'

_v-e2-t02-browser: _v-e2-t02-auth0
	@node --experimental-strip-types tools/verify/e2_t02_auth0.pw.ts

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
verify-E1-T11: _v-gates _v-official-streamfs _v-e1-t10-evidence _v-e1-t11-journal _v-e1-t11-causality _v-e1-t11-capstone _v-e1-t11-external _v-e1-t11-sabotage _v-meta verify-list
	@echo "verify-E1-T11: OK"

verify-E2-T01: _v-gates _v-replay-determinism _v-e2-t01-identity _v-meta verify-list
	@echo "verify-E2-T01: OK"

verify-E2-T02: _v-gates _v-e2-t02-browser _v-meta verify-list
	@echo "verify-E2-T02: OK"

verify-all: verify-E0-T01 verify-E0-T02 verify-E0-T03 verify-E0-T04 verify-E0-T05 verify-E0-T06 verify-E0-T07 verify-E0-T08 verify-E0-T09 verify-E0-T10 verify-E0-T11 verify-E0-T12 verify-E0-T13 verify-E1-T01 verify-E1-T02 verify-E1-T03 verify-E1-T04 verify-E1-T05 verify-E1-T06 verify-E1-T07 verify-E1-T08 verify-E1-T09 verify-E1-T10 verify-E1-T11 verify-E2-T01 verify-E2-T02
	@echo "verify-all: every defined verify target passed"

verify-list:
	@bash tools/verify/list.sh

verify-task-board:
	@pnpm task-board:check

# --- end verify section ---
