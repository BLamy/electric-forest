#!/usr/bin/env bash
# E2-T08 apparatus sensitivity: eight sabotages, each in a detached disposable
# worktree rebuilt from source, each required to turn its named sensor red:
#   (a) projector silently drops registry.repo-visibility-changed events
#   (b) `ef registry rebuild` reuses a stale cached materialization
#   (c) filterForIdentity returns the unfiltered state
#   (d) live frames only are unfiltered (snapshots stay correctly filtered) —
#       this one MUST be caught by the live half of the visibility matrix.
#   (e) hidden SSE frames delivered 500ms late — inside the frozen 2000ms live
#       budget — MUST be caught by the held (>=2000ms past dispatch-accept)
#       suppression-window re-assertion, run-1 verdict demand.
#   (f) the long-poll CATCH-UP call site alone unfiltered (snapshots and the
#       follow loop stay filtered) — MUST be caught by the anonymous/non-member
#       catch-up sensor over pre-existing hidden events, run-1 verdict demand.
#   (g) restrictToOwnRelations drops the owned-outside-relation fallback
#       (/registry/me silently loses repos a subject owns in an org they have
#       no relation to) — MUST be caught by the owned-outside-relation
#       snapshot+live test, run-2 verdict demand (the sabotage that survived
#       the run-2 suite).
#   (h) the server closes every unauthorized (subject===null) SSE tail 50ms
#       after open — MUST be caught by the hold-instant tail-liveness sensor
#       (heartbeat receipt + surfaced stream close), run-3 verdict demand (the
#       sabotage that survived the run-3 apparatus).
# A zero-mutation control must pass every sensor first.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
evidence="$root/.eforest/tasks/epic-2-the-gates/E2-T08-registry-derived-index/evidence/e2-t08-sensitivity.md"
update=0
if [ "${1:-}" = "--update-evidence" ]; then update=1; shift; fi
working_tree=0
if [ "${1:-}" = "--working-tree" ]; then working_tree=1; shift; fi
if [ "$#" -ne 0 ]; then
  echo "usage: tools/verify/e2_t08_sensitivity.sh [--update-evidence] [--working-tree]" >&2
  exit 2
fi
transcript="$(mktemp "${TMPDIR:-/tmp}/eforest-e2-t08-sensitivity.XXXXXX")"
output="$(mktemp "${TMPDIR:-/tmp}/eforest-e2-t08-sensitivity-output.XXXXXX")"
scratch=""
cleanup() {
  if [ -n "$scratch" ]; then
    if ! git -C "$root" worktree remove --force "$scratch" >/dev/null 2>&1; then :; fi
  fi
  rm -f "$transcript" "$output"
}
trap cleanup EXIT

{
  echo '# E2-T08 sensitivity proof'
  echo
  echo 'Each sabotage runs in a detached disposable worktree, rebuilt from source so'
  echo 'the mutation reaches the compiled code every sensor executes. The'
  echo 'zero-mutation control must pass every sensor before any sabotage counts, and'
  echo 'each sabotage must fail its named sensor for the attributable reason quoted'
  echo 'below. Normal verification never modifies this evidence file.'
  echo
} >"$transcript"

link_node_modules() {
  local source_dir="$1" target_dir="$2"
  mkdir -p "$target_dir"
  local entry name sub
  for entry in "$source_dir"/* "$source_dir"/.[!.]*; do
    { [ -e "$entry" ] || [ -L "$entry" ]; } || continue
    name="$(basename "$entry")"
    if [ "$name" = "@eforest" ]; then
      mkdir -p "$target_dir/@eforest"
      for sub in "$entry"/*; do
        { [ -e "$sub" ] || [ -L "$sub" ]; } || continue
        if [ -L "$sub" ]; then
          ln -s "$(readlink "$sub")" "$target_dir/@eforest/$(basename "$sub")"
        else
          ln -s "$sub" "$target_dir/@eforest/$(basename "$sub")"
        fi
      done
    elif [ -L "$entry" ]; then
      ln -s "$(readlink "$entry")" "$target_dir/$name"
    else
      ln -s "$entry" "$target_dir/$name"
    fi
  done
}

prepare_worktree() {
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/eforest-e2-t08-sensitivity.XXXXXX")"
  git -C "$root" worktree add --detach "$scratch" HEAD >/dev/null 2>&1
  if [ "$working_tree" -eq 1 ]; then
    git -C "$root" diff --binary HEAD -- | git -C "$scratch" apply --whitespace=nowarn --allow-empty
    while IFS= read -r path; do
      [ -z "$path" ] && continue
      mkdir -p "$scratch/$(dirname "$path")"
      cp "$root/$path" "$scratch/$path"
    done < <(git -C "$root" ls-files --others --exclude-standard)
  fi
  link_node_modules "$root/node_modules" "$scratch/node_modules"
  for package_modules in "$root"/packages/*/node_modules "$root"/apps/*/node_modules; do
    [ -d "$package_modules" ] || continue
    package_name="$(basename "$(dirname "$package_modules")")"
    package_group="$(basename "$(dirname "$(dirname "$package_modules")")")"
    link_node_modules "$package_modules" "$scratch/$package_group/$package_name/node_modules"
  done
  if ! (cd "$scratch" && CI=true pnpm run build >"$output" 2>&1 && CI=true pnpm --filter @eforest/cli build >>"$output" 2>&1); then
    echo "E2-T08 sensitivity: worktree build failed" >&2
    cat "$output" >&2
    exit 1
  fi
}

drop_worktree() {
  git -C "$root" worktree remove --force "$scratch" >/dev/null
  scratch=""
}

# run_sensor <command...> — captures exit status in sensor_status.
run_sensor() {
  set +e
  (cd "$scratch" && CI=true EFOREST_TEST_PREBUILT=1 "$@") >"$output" 2>&1
  sensor_status=$?
  set -e
}

apply_mutation() {
  local mutation="$1"
  python3 - "$scratch" "$mutation" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
mutation = sys.argv[2]
if mutation == "drop-visibility-events":
    path = root / "packages/platform/src/registry/projector.ts"
    source = path.read_text()
    needle = "        const derived = projectSourceEvent(record.event, record.offset, stream);"
    if source.count(needle) != 1:
        raise SystemExit("drop-visibility anchor missing or duplicated")
    path.write_text(source.replace(
        needle,
        '        if ((record.event as { type?: unknown }).type === "ns.repo.set-visibility") continue;\n' + needle,
    ))
elif mutation == "rebuild-reads-cache":
    path = root / "packages/cli/src/registry-command.ts"
    source = path.read_text()
    needle = "  let server: ReturnType<typeof createDurableStreamTestServer> | undefined;"
    if source.count(needle) != 1:
        raise SystemExit("rebuild-cache anchor missing or duplicated")
    inject = '''  {
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cachePath = join(dataDir, "__registry__.cache.jsonl");
    if (existsSync(cachePath)) {
      const { replayRegistryStream, registryStateDigest } = await import("@eforest/platform");
      const records = readFileSync(cachePath, "utf8").trim().split("\\n").map((line) => JSON.parse(line));
      io.stderr(`registry rebuild: events=${records.length} headOffset=${records.at(-1)?.offset ?? "-1"} pid=${process.pid}\\n`);
      io.stdout(`${registryStateDigest(replayRegistryStream(records))}\\n`);
      return 0;
    }
  }
'''
    path.write_text(source.replace(needle, inject + needle))
elif mutation == "unfiltered-everything":
    path = root / "packages/platform/src/registry/filter.ts"
    source = path.read_text()
    needle = """): RegistryState {
  const orgs: Record<string, RegistryOrgState> = {};
  for (const [orgName, org] of Object.entries(state.orgs)) {"""
    if source.count(needle) != 1:
        raise SystemExit("unfiltered-everything anchor missing or duplicated")
    path.write_text(source.replace(
        needle,
        """): RegistryState {
  if (Object.keys(state.orgs).length >= 0) return state;
  const orgs: Record<string, RegistryOrgState> = {};
  for (const [orgName, org] of Object.entries(state.orgs)) {""",
        1,
    ))
elif mutation == "delayed-live-leak":
    path = root / "packages/platform/src/registry/doors.ts"
    source = path.read_text()
    needle = """              if (frameVisible(record, state, authView, subject, scope)) {
                send(`id: ${record.offset}\\ndata: ${canonicalJson(frameBody(record))}\\n\\n`);
              }"""
    if source.count(needle) != 1:
        raise SystemExit("delayed-live-leak anchor missing or duplicated")
    path.write_text(source.replace(
        needle,
        """              if (frameVisible(record, state, authView, subject, scope)) {
                send(`id: ${record.offset}\\ndata: ${canonicalJson(frameBody(record))}\\n\\n`);
              } else {
                setTimeout(() => {
                  send(`id: ${record.offset}\\ndata: ${canonicalJson(frameBody(record))}\\n\\n`);
                }, 500);
              }""",
        1,
    ))
elif mutation == "unfiltered-longpoll-catchup":
    path = root / "packages/platform/src/registry/doors.ts"
    source = path.read_text()
    needle = "    if (frameVisible(record, state, authView, subject, scope)) frames.push(frameBody(record));"
    if source.count(needle) != 1:
        raise SystemExit("unfiltered-longpoll-catchup anchor missing or duplicated")
    path.write_text(source.replace(
        needle,
        "    frames.push(frameBody(record));",
        1,
    ))
elif mutation == "drop-owned-fallback":
    path = root / "packages/platform/src/registry/filter.ts"
    source = path.read_text()
    needle = "      Object.entries(org.repos).filter(([, repo]) => repo.owner === subject),"
    if source.count(needle) != 1:
        raise SystemExit("drop-owned-fallback anchor missing or duplicated")
    path.write_text(source.replace(
        needle,
        "      Object.entries(org.repos).filter(() => false),",
        1,
    ))
elif mutation == "close-unauthorized-sse-tails":
    path = root / "packages/platform/src/registry/doors.ts"
    source = path.read_text()
    needle = """      heartbeat = setInterval(() => {
        send(": keep-alive\\n\\n");
      }, heartbeatMs);
      heartbeat.unref?.();"""
    if source.count(needle) != 1:
        raise SystemExit("close-unauthorized-sse-tails anchor missing or duplicated")
    path.write_text(source.replace(
        needle,
        needle + """
      if (subject === null) {
        const killer = setTimeout(() => {
          abort.abort();
        }, 50);
        killer.unref?.();
      }""",
        1,
    ))
elif mutation == "unfiltered-live-frames-only":
    path = root / "packages/platform/src/registry/doors.ts"
    source = path.read_text()
    needle = """  const filtered = scopedFilter(postState, authView, subject, scope);
  const org = own(filtered.orgs, payload.org);
  if (org === undefined) return false;"""
    if source.count(needle) != 1:
        raise SystemExit("unfiltered-live anchor missing or duplicated")
    path.write_text(source.replace(
        needle,
        """  const filtered = { orgs: postState.orgs } as RegistryState;
  const org = own(filtered.orgs, payload.org);
  if (org === undefined) return false;""",
        1,
    ))
else:
    raise SystemExit(f"unknown mutation: {mutation}")
PY
  # Rebuild so the mutation reaches compiled code.
  if ! (cd "$scratch" && CI=true pnpm run build >"$output" 2>&1 && CI=true pnpm --filter @eforest/cli build >>"$output" 2>&1); then
    echo "E2-T08 sensitivity: mutated rebuild failed" >&2
    cat "$output" >&2
    exit 1
  fi
}

record() {
  {
    echo "## $1"
    echo
    echo "$2"
    echo
    echo "Result: $3"
    echo
  } >>"$transcript"
}

# --- zero-mutation control -------------------------------------------------
prepare_worktree
run_sensor pnpm exec vitest run packages/platform/test/registry.test.ts
[ "$sensor_status" -eq 0 ] || { echo "control: registry suite RED" >&2; cat "$output" >&2; exit 1; }
run_sensor node tools/verify/e2_t08_matrix.mjs
[ "$sensor_status" -eq 0 ] || { echo "control: matrix RED" >&2; cat "$output" >&2; exit 1; }
run_sensor node tools/verify/e2_t08_destruction.mjs
[ "$sensor_status" -eq 0 ] || { echo "control: destruction RED" >&2; cat "$output" >&2; exit 1; }
record "zero-mutation control" \
  "registry suite, visibility matrix, and destruction proof all green (exit 0) in the disposable worktree." \
  "CONTROL_GREEN"
drop_worktree

# --- (a) projector silently drops visibility-change events -----------------
prepare_worktree
apply_mutation drop-visibility-events
run_sensor pnpm exec vitest run packages/platform/test/registry.test.ts
[ "$sensor_status" -ne 0 ] || { echo "(a) drop-visibility sabotage stayed green" >&2; exit 1; }
grep -q "did not reach 11 events in time\|AssertionError" "$output" || {
  echo "(a) failed for an unattributable reason" >&2; cat "$output" >&2; exit 1; }
record "(a) projector silently drops registry.repo-visibility-changed" \
  "Sensor: registry suite. Went red (nonzero exit): the golden tree never materializes its 11th derived event; every door/digest assertion downstream of the drop fails." \
  "DROP_VISIBILITY_SENSITIVITY_OK"
drop_worktree

# --- (b) rebuild reuses a stale cached materialization ---------------------
prepare_worktree
apply_mutation rebuild-reads-cache
run_sensor node tools/verify/e2_t08_destruction.mjs
[ "$sensor_status" -ne 0 ] || { echo "(b) rebuild-cache sabotage stayed green" >&2; exit 1; }
record "(b) ef registry rebuild reuses a stale cached materialization" \
  "Sensor: destruction proof. Went red (nonzero exit): the corrupt-leftover probe caught the rebuild consulting the planted cache copy instead of replaying the source logs." \
  "REBUILD_CACHE_SENSITIVITY_OK"
drop_worktree

# --- (c) filterForIdentity returns the unfiltered state --------------------
prepare_worktree
apply_mutation unfiltered-everything
run_sensor node tools/verify/e2_t08_matrix.mjs
[ "$sensor_status" -ne 0 ] || { echo "(c) unfiltered sabotage stayed green" >&2; exit 1; }
grep -q "registry/public\|org/acme\|/registry" "$output" || {
  echo "(c) failed for an unattributable reason" >&2; cat "$output" >&2; exit 1; }
record "(c) filterForIdentity returns the unfiltered state" \
  "Sensor: visibility matrix (snapshot half). Went red (nonzero exit) on the literal snapshot entry-set assertions — private entries leaked into anonymous/non-member listings." \
  "UNFILTERED_SENSITIVITY_OK"
drop_worktree

# --- (d) live frames only unfiltered (snapshots stay filtered) -------------
prepare_worktree
apply_mutation unfiltered-live-frames-only
run_sensor node tools/verify/e2_t08_matrix.mjs
[ "$sensor_status" -ne 0 ] || { echo "(d) live-only sabotage stayed green" >&2; exit 1; }
# The sabotage leaves snapshots filtered, so the failure MUST come from the
# live half — the anonymous/non-member tail assertions — not any snapshot line.
grep -q "anonymous tail saw a private creation frame\|non-member tail saw a private creation frame\|anonymous tail received a frame" "$output" || {
  echo "(d) was not caught by the live half of the matrix" >&2; cat "$output" >&2; exit 1; }
record "(d) live frames only unfiltered (snapshots left correctly filtered)" \
  "Sensor: visibility matrix, LIVE half specifically. Went red on the held-open anonymous/non-member tail zero-frame assertion — the snapshot half passed (it runs first), so the catch is attributable to the live matrix alone." \
  "UNFILTERED_LIVE_SENSITIVITY_OK"
drop_worktree

# --- (e) hidden SSE frames delivered late but inside the live budget --------
prepare_worktree
apply_mutation delayed-live-leak
run_sensor node tools/verify/e2_t08_matrix.mjs
[ "$sensor_status" -ne 0 ] || { echo "(e) delayed-leak sabotage stayed green" >&2; exit 1; }
grep -q "leaked within the held 2000ms window" "$output" || {
  echo "(e) was not caught by the held suppression window" >&2; cat "$output" >&2; exit 1; }
record "(e) hidden SSE frames delivered 500ms late (inside the frozen 2000ms live budget)" \
  "Sensor: visibility matrix, held suppression window. Went red on the >=2000ms-past-dispatch-accept re-assertion of the anonymous/non-member zero-frame logs — an assertion pinned only to the authorized frame's arrival instant (~tens of ms) would have stayed green on this within-budget skew." \
  "DELAYED_LEAK_SENSITIVITY_OK"
drop_worktree

# --- (f) long-poll catch-up call site alone unfiltered ----------------------
prepare_worktree
apply_mutation unfiltered-longpoll-catchup
run_sensor node tools/verify/e2_t08_matrix.mjs
[ "$sensor_status" -ne 0 ] || { echo "(f) catch-up unfilter sabotage stayed green" >&2; exit 1; }
grep -q "long-poll catch-up leaked hidden frames" "$output" || {
  echo "(f) was not caught by the catch-up sensor" >&2; cat "$output" >&2; exit 1; }
record "(f) long-poll CATCH-UP call site unfiltered (snapshots and the follow loop stay filtered)" \
  "Sensor: visibility matrix, anonymous/non-member long-poll catch-up over pre-existing hidden events (early after, waitMs=0). Went red on the literal visible-frame assertion — private frames surfaced in the catch-up response while every snapshot and follow-loop sensor stayed green." \
  "CATCHUP_UNFILTER_SENSITIVITY_OK"
drop_worktree

# --- (g) restrictToOwnRelations drops the owned-outside-relation fallback ---
prepare_worktree
apply_mutation drop-owned-fallback
run_sensor pnpm exec vitest run packages/platform/test/registry.test.ts
[ "$sensor_status" -ne 0 ] || { echo "(g) drop-owned-fallback sabotage stayed green" >&2; exit 1; }
grep -q "owned-outside-relation" "$output" || {
  echo "(g) was not caught by the owned-outside-relation sensor" >&2; cat "$output" >&2; exit 1; }
record "(g) restrictToOwnRelations drops the owned-outside-relation fallback" \
  "Sensor: registry suite, the owned-outside-relation snapshot+live test (run-2 verdict demand). Went red (nonzero exit): a subject owning a repo in an org they have no relation to — via non-member create and via post-revocation — vanished from /registry/me in both snapshot and live catch-up assertions. This is the exact filter.ts owner-fallback mutation the run-2 committed suite stayed green on." \
  "DROP_OWNED_FALLBACK_SENSITIVITY_OK"
drop_worktree

# --- (h) server closes every unauthorized SSE tail 50ms after open ----------
prepare_worktree
apply_mutation close-unauthorized-sse-tails
run_sensor node tools/verify/e2_t08_matrix.mjs
[ "$sensor_status" -ne 0 ] || { echo "(h) close-unauthorized-tails sabotage stayed green" >&2; exit 1; }
grep -q "not alive at the held instant" "$output" || {
  echo "(h) was not caught by the tail-liveness sensor" >&2; cat "$output" >&2; exit 1; }
record "(h) server closes every unauthorized (subject===null) SSE tail 50ms after open" \
  "Sensor: visibility matrix, hold-instant tail liveness (run-3 verdict demand — the sabotage the run-3 apparatus survived). Went red: the anonymous/non-member tails' liveness assertion at >=2000ms past dispatch-accept (stream still open + heartbeat received after dispatch-accept) threw 'not alive at the held instant (stream closed by server)' — a dead connection can no longer satisfy the zero-frame suppression clause, and the positive public-frame sensor on the same held tails would equally starve." \
  "CLOSE_UNAUTHORIZED_TAILS_SENSITIVITY_OK"
drop_worktree

echo 'Any sabotage the sensors stay green on fails verify-E2-T08.' >>"$transcript"

if [ "$update" -eq 1 ]; then
  cp "$transcript" "$evidence"
else
  cmp -s "$transcript" "$evidence" || {
    echo "E2-T08 sensitivity evidence drifted; regenerate explicitly with --update-evidence" >&2
    if ! diff -u "$evidence" "$transcript" >&2; then :; fi
    exit 1
  }
fi
cat "$transcript"
