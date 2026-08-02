# electric-forest verification entrypoints. Durable Streams protocol behavior is
# supplied by Electric's published packages; this repo verifies only its adapters,
# application event model, replay tooling, and StreamFS product behavior.

# --- Adversarial-verification tooling ---

.PHONY: verify-E3-T10 verify-E3-capstone _verify-E3-T10-inner _v-e3-t10

.PHONY: verify-all verify-list \
	verify-E0-T01 verify-E0-T02 verify-E0-T03 verify-E0-T04 verify-E0-T05 \
	verify-E0-T06 verify-E0-T07 verify-E0-T08 verify-E0-T09 verify-E0-T10 \
	verify-E0-T11 verify-E0-T12 verify-E0-T13 verify-E1-T01 verify-E1-T02 \
	verify-E1-T03 verify-E1-T04 verify-E1-T05 verify-E1-T06 verify-E1-T07 \
	verify-E1-T08 verify-E1-T09 verify-E1-T10 verify-E1-T11 verify-E2-T01 verify-E2-T02 verify-E2-T03 verify-E2-T04 verify-E2-T05 verify-E2-T06 verify-E2-T07 verify-E2-T08 verify-E2-T09 verify-E2-T10 verify-E2-T11 verify-E2-T12 verify-E2-capstone verify-E3-seed verify-E3-T01 verify-E3-T02a verify-E3-T02b verify-E3-T02 verify-E3-T03 verify-E3-T04 verify-E3-T05 verify-E3-T06 verify-E3-T07 verify-E3-T08 verify-E3-T09 verify-E3-shell seed-canopy regen-E3-seed _verify-E2-T05-inner _verify-E2-T06-inner _verify-E2-T07-inner _verify-E2-T08-inner _verify-E2-T09-inner _verify-E2-T12-inner _verify-E3-T02a-inner _verify-E3-T02b-inner _verify-E3-T03-inner _verify-E3-T04-inner _verify-E3-T05-inner _verify-E3-T06-inner _verify-E3-T07-inner _verify-E3-T08-inner _verify-E3-T09-inner _verify-E3-shell-inner _v-install _v-fmt _v-lint \
	_v-typecheck _v-test _v-build _v-gates _v-official-streamfs _v-e1-t10-evidence \
	_v-e1-t11-capstone _v-e1-t11-causality _v-e1-t11-external _v-e1-t11-journal _v-e1-t11-sabotage \
	_v-replay-determinism _v-e2-t01-identity _v-e2-t02-auth0 _v-e2-t02-browser _v-e2-t03-gateway _v-e2-t04-network-init _v-e2-t04-auth _v-e2-t04-browser _v-e2-t05-network-init _v-e2-t05 _v-e2-t06 _v-e2-t07 _v-e2-t08 _v-e2-t09 _v-e2-t11 _v-e2-t12 _v-e3-seed-prep _v-e3-seed _v-e3-shell _v-e3-t03 _v-e3-t04 _v-e3-t05 _v-e3-t06 _v-e3-t07 _v-e3-t08 _v-e3-t09 _v-meta verify-task-board

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
	@CI=true EFOREST_TEST_PREBUILT=1 pnpm exec vitest run --maxWorkers=1 packages/cli/src/official.integration.test.ts packages/streamfs/test/domain.test.ts packages/streamfs/test/patch.property.test.ts packages/streamfs/test/durable-streams.integration.test.ts packages/streamfs/test/three-way-merge.test.ts packages/streamfs/test/three-way-merge.integration.test.ts packages/streamfs/test/three-way-merge-adversarial.integration.test.ts packages/streamfs/test/three-way-merge-identity-boundaries.integration.test.ts packages/streamfs/test/verify-task-workflow.test.ts

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

verify-E2-T04 _verify-E2-T04-inner _v-e2-t04-auth _v-e2-t04-browser: export HTTP_PROXY := http://127.0.0.1:1
verify-E2-T04 _verify-E2-T04-inner _v-e2-t04-auth _v-e2-t04-browser: export HTTPS_PROXY := http://127.0.0.1:1
verify-E2-T04 _verify-E2-T04-inner _v-e2-t04-auth _v-e2-t04-browser: export NO_PROXY := 127.0.0.1,localhost,::1
verify-E2-T04 _verify-E2-T04-inner _v-e2-t04-auth _v-e2-t04-browser: export http_proxy := http://127.0.0.1:1
verify-E2-T04 _verify-E2-T04-inner _v-e2-t04-auth _v-e2-t04-browser: export https_proxy := http://127.0.0.1:1
verify-E2-T04 _verify-E2-T04-inner _v-e2-t04-auth _v-e2-t04-browser: export no_proxy := 127.0.0.1,localhost,::1
verify-E2-T04 _verify-E2-T04-inner _v-e2-t04-network-init _v-e2-t04-auth _v-e2-t04-browser: export NODE_OPTIONS := --import=$(CURDIR)/tools/verify/loopback_fetch_guard.mjs
verify-E2-T04 _verify-E2-T04-inner _v-e2-t04-network-init _v-e2-t04-auth _v-e2-t04-browser: export E2_T04_PROCESS_NETWORK_LOG := $(TMPDIR)/e2-t04-process-network.log

verify-E2-T05 _verify-E2-T05-inner _v-e2-t05-network-init _v-e2-t05: export HTTP_PROXY := http://127.0.0.1:1
verify-E2-T05 _verify-E2-T05-inner _v-e2-t05-network-init _v-e2-t05: export HTTPS_PROXY := http://127.0.0.1:1
verify-E2-T05 _verify-E2-T05-inner _v-e2-t05-network-init _v-e2-t05: export NO_PROXY := 127.0.0.1,localhost,::1
verify-E2-T05 _verify-E2-T05-inner _v-e2-t05-network-init _v-e2-t05: export http_proxy := http://127.0.0.1:1
verify-E2-T05 _verify-E2-T05-inner _v-e2-t05-network-init _v-e2-t05: export https_proxy := http://127.0.0.1:1
verify-E2-T05 _verify-E2-T05-inner _v-e2-t05-network-init _v-e2-t05: export no_proxy := 127.0.0.1,localhost,::1
verify-E2-T05 _verify-E2-T05-inner _v-e2-t05-network-init _v-e2-t05: export NODE_OPTIONS := --import=$(CURDIR)/tools/verify/loopback_fetch_guard.mjs
verify-E2-T05 _verify-E2-T05-inner _v-e2-t05-network-init _v-e2-t05: export E2_T04_PROCESS_NETWORK_LOG := $(TMPDIR)/e2-t05-process-network.log

verify-E2-T12 verify-E2-capstone _verify-E2-T12-inner _v-e2-t12: export HTTP_PROXY := http://127.0.0.1:1
verify-E2-T12 verify-E2-capstone _verify-E2-T12-inner _v-e2-t12: export HTTPS_PROXY := http://127.0.0.1:1
verify-E2-T12 verify-E2-capstone _verify-E2-T12-inner _v-e2-t12: export NO_PROXY := 127.0.0.1,localhost,::1
verify-E2-T12 verify-E2-capstone _verify-E2-T12-inner _v-e2-t12: export http_proxy := http://127.0.0.1:1
verify-E2-T12 verify-E2-capstone _verify-E2-T12-inner _v-e2-t12: export https_proxy := http://127.0.0.1:1
verify-E2-T12 verify-E2-capstone _verify-E2-T12-inner _v-e2-t12: export no_proxy := 127.0.0.1,localhost,::1

verify-E3-shell verify-E3-T02 _verify-E3-shell-inner _v-e3-shell: export HTTP_PROXY := http://127.0.0.1:1
verify-E3-shell verify-E3-T02 _verify-E3-shell-inner _v-e3-shell: export HTTPS_PROXY := http://127.0.0.1:1
verify-E3-shell verify-E3-T02 _verify-E3-shell-inner _v-e3-shell: export NO_PROXY := 127.0.0.1,localhost,::1
verify-E3-shell verify-E3-T02 _verify-E3-shell-inner _v-e3-shell: export http_proxy := http://127.0.0.1:1
verify-E3-shell verify-E3-T02 _verify-E3-shell-inner _v-e3-shell: export https_proxy := http://127.0.0.1:1
verify-E3-shell verify-E3-T02 _verify-E3-shell-inner _v-e3-shell: export no_proxy := 127.0.0.1,localhost,::1
verify-E3-shell verify-E3-T02 _verify-E3-shell-inner _v-e3-shell: export NODE_OPTIONS := --import=$(CURDIR)/tools/verify/loopback_fetch_guard.mjs
verify-E3-shell verify-E3-T02 _verify-E3-shell-inner _v-e3-shell: export E2_T04_PROCESS_NETWORK_LOG := $(TMPDIR)/e3-t02-process-network.log

_v-e2-t02-auth0:
	@if [ ! -e vendor/emulate/.git ]; then git submodule update --init --recursive vendor/emulate; fi
	@test "$$(git -C vendor/emulate rev-parse HEAD)" = "82eb835947c97fcf6e0596a4377acbb01ca13ede"
	@CI=true corepack pnpm@11.2.2 --pm-on-fail=ignore --dir vendor/emulate install --frozen-lockfile
	@CI=true corepack pnpm@11.2.2 --pm-on-fail=ignore --dir vendor/emulate exec turbo build --filter=emulate
	@node tools/verify/normalize_emulate_cli.mjs
	@CI=true corepack pnpm@11.2.2 --pm-on-fail=ignore --dir vendor/emulate --filter @emulators/auth0 test
	@CI=true corepack pnpm@11.2.2 --pm-on-fail=ignore --dir vendor/emulate --filter emulate test
	@node tools/verify/e2_t02_auth0.mjs
	@node tools/verify/e2_t02_cli.mjs
	@! git grep -n -E 'vendor/emulate|@emulators/auth0' -- 'packages/*/src' 'apps/*/src'

_v-e2-t02-browser: _v-e2-t02-auth0
	@node --experimental-strip-types tools/verify/e2_t02_auth0.pw.ts

_v-e2-t03-gateway: _v-build _v-e2-t02-auth0
	@node tools/verify/e2_t03_gateway.mjs
	@! git grep -n -E 'vendor/emulate|@emulators/auth0' -- 'packages/platform/src'
	@test -z "$$(git diff --name-only 4df852d341bae1147f0d3fe985c6baa78a8ffe57..HEAD -- packages/server)"

_v-e2-t04-auth: _v-build _v-e2-t02-auth0
	@CI=true pnpm exec vitest run packages/platform/test/auth.test.ts
	@! git grep -in emulator -- packages/platform/src
	@test "$$(node packages/cli/dist/src/bin.js replay .eforest/tasks/epic-2-the-gates/E2-T04-web-login-sessions/evidence/e2-t04-two-logins.events.jsonl --digest --reducer packages/identity/reducer.mjs)" = "$$(cat .eforest/tasks/epic-2-the-gates/E2-T04-web-login-sessions/evidence/e2-t04-two-logins.digest)"

_v-e2-t04-browser: _v-e2-t04-auth
	@$(MAKE) --no-print-directory _v-e2-t04-network-init
	@node --experimental-strip-types packages/platform/test/login.pw.ts

_v-e2-t04-network-init:
	@rm -f "$(E2_T04_PROCESS_NETWORK_LOG)"
	@node tools/verify/e2_t04_os_network_canary.mjs
	@node -e 'fetch("https://auth0.com/e2-t04-process-canary").then(() => process.exit(1), () => undefined)'

_v-e2-t05-network-init:
	@rm -f "$(E2_T04_PROCESS_NETWORK_LOG)"
	@node tools/verify/e2_t04_os_network_canary.mjs
	@node -e 'fetch("https://auth0.com/e2-t05-process-canary").then(() => process.exit(1), () => undefined)'

_v-e2-t05: _v-build _v-e2-t02-auth0
	@CI=true pnpm exec vitest run packages/cli/test/login.device-flow.test.ts packages/cli/test/credentials.test.ts packages/platform/test/cli-tokens.test.ts
	@test "$$(node packages/cli/dist/src/bin.js replay .eforest/tasks/epic-2-the-gates/E2-T05-cli-device-token-flow/evidence/e2-t05-identity-golden.jsonl --digest --reducer packages/identity/reducer.mjs)" = "$$(cat .eforest/tasks/epic-2-the-gates/E2-T05-cli-device-token-flow/evidence/e2-t05-identity-golden.digest)"
	@.eforest/tasks/epic-2-the-gates/E2-T05-cli-device-token-flow/evidence/e2-t05-transcript.sh
	@node --experimental-strip-types packages/platform/test/cli-tokens.pw.ts
	@node tools/verify/e2_t05_evidence.mjs

_v-e2-t06: _v-build
	@CI=true pnpm exec vitest run packages/platform/test/ns.test.ts packages/platform/test/ns.fuzz.test.ts
	@node tools/verify/e2_t06_evidence.mjs
	@node tools/verify/e2_t06_restart.mjs
	@node tools/verify/e2_t06_runtime_boundary.mjs
	@node tools/verify/e2_t06_no_database.mjs
	@bash tools/verify/e2_t06_no_database_sensitivity.sh
	@bash tools/verify/e2_t06_sensitivity.sh

_v-e2-t07: _v-build _v-e2-t02-auth0
	@CI=true pnpm exec vitest run packages/platform/test/authz.test.ts packages/platform/test/authz.gateway.test.ts
	@node tools/verify/e2_t07_matrix.mjs
	@node tools/verify/e2_t07_sensitivity.mjs
	@! git grep -n -E 'vendor/emulate|@emulators/auth0' -- 'packages/platform/src'
	@test -z "$$(git diff --name-only 4df852d341bae1147f0d3fe985c6baa78a8ffe57..HEAD -- packages/server)"

_v-e2-t08: _v-build
	@CI=true EFOREST_TEST_PREBUILT=1 pnpm exec vitest run packages/platform/test/registry.test.ts packages/platform/test/registry.rebuild.test.ts
	@node tools/verify/e2_t08_evidence.mjs
	@node tools/verify/e2_t08_matrix.mjs
	@node tools/verify/e2_t08_live.mjs
	@node tools/verify/e2_t08_refusals.mjs
	@node tools/verify/e2_t08_destruction.mjs
	@node tools/verify/e2_t08_crash.mjs
	@node tools/verify/e2_t08_no_database.mjs
	@node tools/verify/e2_t08_no_database_sensitivity.mjs
	@bash tools/verify/e2_t08_sensitivity.sh

_v-e2-t09: _v-build
	@CI=true EFOREST_TEST_PREBUILT=1 pnpm exec vitest run packages/platform/test/writer-lanes.test.ts packages/platform/test/gateway.test.ts packages/platform/test/authz.gateway.test.ts packages/platform/test/cli-tokens.test.ts
	@node tools/verify/e2_t09_evidence.mjs
	@node tools/verify/e2_t09_sensitivity.mjs
	@! git grep -n -E 'Producer-(Id|Epoch|Seq).*auth|writer.*header' -- 'packages/platform/src'
	@test -z "$$(git diff --name-only 145853d..HEAD -- packages/server)"

_v-e2-authz: _v-e2-t07 _v-e2-t08 _v-e2-t09
	@CI=true EFOREST_TEST_PREBUILT=1 pnpm exec vitest run packages/platform/test/cli-tokens.test.ts packages/platform/test/authz.gateway.test.ts packages/platform/test/ns.test.ts
	@node tools/verify/e2_t10_operations.mjs
	@node tools/verify/e2_t10_authz.mjs
	@node tools/verify/e2_t10_sensitivity.mjs

verify-E2-authz: _v-e2-authz
	@echo "verify-E2-authz: OK"

_v-e2-t11: _v-build
	@CI=true EFOREST_TEST_PREBUILT=1 pnpm exec vitest run packages/platform/test/rate-limit.test.ts packages/platform/test/authz.gateway.test.ts packages/platform/test/cli-tokens.test.ts
	@node tools/verify/e2_t11_evidence.mjs
	@node tools/verify/e2_t11_sensitivity.mjs
	@! git grep -n -E 'FixedWindowRateLimiter|decideTenantAccess|rate_limited' -- 'packages/server'
	@test -z "$$(git diff --name-only 3dbbb7696577b001870989ad5180219315beaec9..HEAD -- packages/server)"

_v-e2-t12: _v-build _v-e2-t02-auth0
	@node tools/verify/e2_t12_portability.mjs
	@node --experimental-strip-types tools/verify/e2_t12_capstone.pw.ts
	@test "$$(node packages/cli/dist/src/bin.js replay .eforest/tasks/epic-2-the-gates/E2-T12-the-locked-gate/evidence/e2-t12-after.jsonl --digest --reducer tools/verify/e2_t12_reducer.mjs)" = "$$(node -e 'const value=require("./.eforest/tasks/epic-2-the-gates/E2-T12-the-locked-gate/evidence/e2-t12-capstone.json"); process.stdout.write(value.steps.authorized.after.digest)')"
	@! git grep -n -E 'vendor/emulate|@emulators/auth0' -- 'packages/*/src' 'apps/*/src'

_v-e3-seed-prep: _v-build
	@if [ ! -e vendor/emulate/.git ]; then git submodule update --init --recursive vendor/emulate; fi
	@test "$$(git -C vendor/emulate rev-parse HEAD)" = "82eb835947c97fcf6e0596a4377acbb01ca13ede"
	@CI=true corepack pnpm@11.2.2 --pm-on-fail=ignore --dir vendor/emulate install --frozen-lockfile
	@CI=true corepack pnpm@11.2.2 --pm-on-fail=ignore --dir vendor/emulate exec turbo build --filter=emulate
	@node tools/verify/normalize_emulate_cli.mjs

seed-canopy: _v-e3-seed-prep
	@node --experimental-strip-types tools/verify/seed-canopy.ts $(if $(OUT),--out "$(OUT)",)

regen-E3-seed: _v-e3-seed-prep
	@node tools/verify/canopy_verify.mjs --regen

_v-e3-seed: _v-e3-seed-prep
	@node tools/verify/canopy_sensitivity_spine_check.mjs
	@node tools/verify/canopy_sensitivity_spine_sabotage.mjs
	@node tools/verify/canopy_verify.mjs

_v-e3-t02a:
	@node tools/verify/e3_t02_contract_check.mjs
	@node tools/verify/e3_t02_production.mjs
	@node --experimental-strip-types apps/web/test/shell.pw.ts

_v-e3-t02b:
	@node tools/verify/e3_t02_wire_sensitivity.mjs
	@node tools/verify/e3_t02_replay_cli_contract.mjs
	@node tools/verify/e3_t02_recorder_sensitivity.mjs

_v-e3-shell: _v-e3-t02a _v-e3-t02b

_v-e3-t03:
	@pnpm vitest run packages/protocol/src/digest.test.ts packages/reducers/src/index.test.ts packages/platform/test/application-projection.test.ts packages/web-hooks/src/useStreamReducer.test.ts
	@node --experimental-strip-types apps/web/test/stream-reducer.pw.ts

_v-e3-t04:
	@pnpm vitest run packages/platform/test/registry.test.ts packages/reducers/src/index.test.ts packages/web-hooks/src/useStreamReducer.test.ts
	@node --experimental-strip-types apps/web/test/registry-live.pw.ts

_v-e3-t05:
	@pnpm vitest run packages/reducers/src/index.test.ts packages/platform/test/repo-home.test.ts
	@node --experimental-strip-types apps/web/test/repo-home.pw.ts
	@node tools/verify/e3_t05_evidence.mjs

_v-e3-t06:
	@node --experimental-strip-types apps/web/test/file-tree.pw.ts
	@node tools/verify/e3_t06_evidence.mjs

_v-e3-t07: _v-build
	@CI=true pnpm exec vitest run packages/reducers/src/file-content.test.ts packages/platform/test/file-viewer.test.ts packages/platform/test/spa.test.ts
	@node --experimental-strip-types apps/web/test/file-viewer.pw.ts
	@node tools/verify/e3_t07_evidence.mjs

_v-e3-t08: _v-build
	@CI=true pnpm exec vitest run packages/platform/test/branch-projection.test.ts packages/platform/test/file-viewer.test.ts packages/web-hooks/src/useStreamReducer.test.ts
	@node --experimental-strip-types apps/web/test/branch-switcher.pw.ts
	@node tools/verify/e3_t08_evidence.mjs

_v-e3-t09: _v-build
	@CI=true pnpm exec vitest run packages/platform/test/history.test.ts packages/web-hooks/src/useStreamReducer.test.ts
	@node --experimental-strip-types apps/web/test/history-event-log.pw.ts
	@node tools/verify/e3_t09_evidence.mjs

_v-e3-t10: _v-build
	@node --experimental-strip-types apps/web/test/reading-room-capstone.pw.ts
	@node tools/verify/e3_t10_evidence.mjs

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

verify-E2-T03: _v-gates _v-e2-t03-gateway _v-meta verify-list
	@echo "verify-E2-T03: OK"

verify-E2-T04:
	@tools/verify/e2_t04_loopback.sh make --no-print-directory _verify-E2-T04-inner
	@echo "verify-E2-T04: OK"

_verify-E2-T04-inner: _v-e2-t04-network-init _v-gates _v-e2-t04-browser _v-meta verify-list

verify-E2-T05:
	@tools/verify/e2_t05_loopback.sh make --no-print-directory _verify-E2-T05-inner
	@echo "verify-E2-T05: OK"

_verify-E2-T05-inner: _v-e2-t05-network-init _v-gates _v-e2-t05 _v-meta verify-list
	@$(MAKE) --no-print-directory verify-E2-T03
	@E2_T04_OS_SANDBOX_ACTIVE=1 $(MAKE) --no-print-directory verify-E2-T04

verify-E2-T06:
	@tools/verify/e2_t06_loopback.sh make --no-print-directory _verify-E2-T06-inner
	@echo "verify-E2-T06: OK"

# Compose upstream proof surfaces in this make graph so shared prerequisites such as
# _v-gates and _v-build execute once at the final candidate, rather than recursively
# launching three complete verification targets against the same commit.
_verify-E2-T06-inner: _v-gates _v-e2-t06 _v-replay-determinism _v-e2-t01-identity _v-e2-t03-gateway _v-official-streamfs _v-meta verify-list

verify-E2-T07:
	@tools/verify/e2_t07_loopback.sh make --no-print-directory _verify-E2-T07-inner
	@echo "verify-E2-T07: OK"

_verify-E2-T07-inner: _v-gates _v-e2-t07 _verify-E2-T06-inner _v-meta verify-list

verify-E2-T08: _verify-E2-T08-inner
	@echo "verify-E2-T08: OK"

_verify-E2-T08-inner: _v-gates _v-e2-t08 _verify-E2-T07-inner _v-meta verify-list

verify-E2-T09: _verify-E2-T09-inner
	@echo "verify-E2-T09: OK"

_verify-E2-T09-inner: _v-e2-t09 _verify-E2-T08-inner _v-meta verify-list

verify-E2-T10: _v-gates _v-e2-authz _v-meta verify-list
	@echo "verify-E2-T10: OK"

verify-E2-T11: _v-gates _v-e2-t11 _v-e2-authz _v-meta verify-list
	@echo "verify-E2-T11: OK"

verify-E2-T12:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E2-T12-inner
	@echo "verify-E2-T12: OK"

verify-E2-capstone:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E2-T12-inner
	@echo "verify-E2-capstone: OK"

_verify-E2-T12-inner: _v-gates _v-e2-t12 _v-e2-t11 _v-e2-authz _v-meta verify-list

verify-E3-seed: _v-e3-seed _v-meta verify-list
	@echo "verify-E3-seed: OK"

verify-E3-T01: _v-gates _v-e3-seed _v-meta verify-list
	@echo "verify-E3-T01: OK"

verify-E3-shell:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E3-shell-inner
	@echo "verify-E3-shell: OK"

verify-E3-T02a:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E3-T02a-inner
	@echo "verify-E3-T02a: OK"

verify-E3-T02b:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E3-T02b-inner
	@echo "verify-E3-T02b: OK"

verify-E3-T02:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E3-shell-inner
	@echo "verify-E3-T02: OK"

verify-E3-T03:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E3-T03-inner
	@echo "verify-E3-T03: OK"

verify-E3-T04:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E3-T04-inner
	@echo "verify-E3-T04: OK"

verify-E3-T05:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E3-T05-inner
	@echo "verify-E3-T05: OK"

verify-E3-T06:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E3-T06-inner
	@echo "verify-E3-T06: OK"

verify-E3-T07:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E3-T07-inner
	@echo "verify-E3-T07: OK"

verify-E3-T08:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E3-T08-inner
	@echo "verify-E3-T08: OK"

verify-E3-T09:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E3-T09-inner
	@echo "verify-E3-T09: OK"

verify-E3-T10:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E3-T10-inner
	@echo "verify-E3-T10: OK"

verify-E3-capstone:
	@tools/verify/e2_t12_loopback.sh make --no-print-directory _verify-E3-T10-inner
	@echo "verify-E3-capstone: OK"

_verify-E3-T02a-inner: _v-gates _v-e2-t02-auth0 _v-e3-t02a _v-meta verify-list

_verify-E3-T02b-inner: _verify-E3-T02a-inner _v-e3-t02b

_verify-E3-T03-inner: _verify-E3-shell-inner _v-e3-t03

_verify-E3-T04-inner: _verify-E3-T03-inner _v-e3-t04

_verify-E3-T05-inner: _verify-E3-T04-inner _v-e3-t05

_verify-E3-T06-inner: _verify-E3-T05-inner _v-e3-t06

_verify-E3-T07-inner: _verify-E3-T06-inner _v-e3-t07

_verify-E3-T08-inner: _verify-E3-T07-inner _v-e3-t08

_verify-E3-T09-inner: _verify-E3-T08-inner _v-e3-t09

_verify-E3-T10-inner: _verify-E3-T09-inner _v-e3-t10 _v-meta verify-list

_verify-E3-shell-inner: _v-gates _v-e2-t02-auth0 _v-e3-shell _v-meta verify-list

verify-all: verify-E0-T01 verify-E0-T02 verify-E0-T03 verify-E0-T04 verify-E0-T05 verify-E0-T06 verify-E0-T07 verify-E0-T08 verify-E0-T09 verify-E0-T10 verify-E0-T11 verify-E0-T12 verify-E0-T13 verify-E1-T01 verify-E1-T02 verify-E1-T03 verify-E1-T04 verify-E1-T05 verify-E1-T06 verify-E1-T07 verify-E1-T08 verify-E1-T09 verify-E1-T10 verify-E1-T11 verify-E2-T01 verify-E2-T02 verify-E2-T03 verify-E2-T04 verify-E2-T05 verify-E2-T06 verify-E2-T07 verify-E2-T08 verify-E2-T09 verify-E2-T10 verify-E2-T11 verify-E2-T12 verify-E3-seed verify-E3-T01 verify-E3-T02 verify-E3-T03 verify-E3-T04 verify-E3-T05 verify-E3-T06 verify-E3-T07 verify-E3-T08 verify-E3-T09
	@echo "verify-all: every defined verify target passed"

verify-all: verify-E3-T10

verify-list:
	@bash tools/verify/list.sh

verify-task-board:
	@pnpm task-board:check

# --- end verify section ---
