# Critic runbook

The doctrine: a task is done **only when a hostile critic fails to break it.**
This runbook makes that mechanical. It operationalizes the repo-level protocol in
`AGENTS.md` and `tools/replay/` per-task — it does not restate it. (Ported from wasm-vm
via the figma-clone; the stream-layer evidence unit here is a dumped event log replayed
to a state digest, the browser-layer unit an uploaded Replay recording cited by URL.)

## The evidence gate

Before anything else: **if the claim cites no Replay recording URL and no event-log
digest, the verdict is `needs-evidence` before you read a line of code.** Absence must be
declared, never silent — `Replay: N/A (<reason>) + mitigation` is legitimate; saying
nothing is not.

## The loop

1. **Cold-clone first.** Never verify the implementer's working tree.
   ```sh
   tools/verify/cold_clone.sh verify-E0-T05      # pristine HEAD, scrubbed env
   ```
   This clones the committed HEAD into a scratch dir with `NODE_OPTIONS`/`NODE_ENV`/
   `npm_config_*` (and obsolete Rust vars) scrubbed and a trusted `PATH`
   prepended (`REPLAY_API_KEY` is preserved so evidence upload still works), then runs
   the target. A green here is a real green.

2. **Run the task's verify target.** `make verify-E<n>-T<nn>` encodes that task's
   acceptance criteria as commands with real exit codes. `make verify-list` maps every
   target to its task; `make verify-all` is the standing regression suite every epic
   runs before touching the core.

3. **Run the task's listed attack angles.** Each task readme has an "Adversarial
   verification" section — execute every item, **with your own seeds and inputs, never
   the builder's**. Record the final happy run so the session is interrogable, and cite
   the recording URL:
   ```sh
   tools/replay/record-run.sh -o e3-t04-verify   # uploads; prints the recording URL
   ```
   Interrogate recordings through the Replay MCP (`tools/replay/README.md` has the
   cheatsheet); every browser-layer finding cites a point link
   (`https://app.replay.io/recording/<id>?point=<p>&time=<ms>`), every stream-layer
   finding cites an event-log offset + digest.

4. **Invent at least one novel attack** the task author did not list — AND
   mutation-test the armor: break one acceptance criterion in a scratch branch and
   confirm the corresponding `verify-E<n>-T<nn>` turns **red**. A mutant that stays
   green is a refutation of the check, not just the code.

5. **Append a structured Verification-log entry** to the bottom of the task readme
   (template below, format per `AGENTS.md`) and flip `status`:
   - all attacks failed to break it → `verified`;
   - any attack succeeded → `refuted` (builder reworks, then re-verify from step 1);
   - evidence missing or uninspectable → verdict `needs-evidence` in the log entry,
     frontmatter status back to `in-progress` (the verdict lives in the log; the
     frontmatter status vocabulary has no needs-evidence value).
   Then `python3 tools/build_queue.py` and commit.

## Skips are loud

A check needing missing tooling (pnpm pre-E0-T01, Playwright, the Replay runtime)
prints `SKIPPED: <reason>` and **exits nonzero** — silence is forbidden. Override only
when you have consciously accepted the gap:
```sh
VERIFY_ALLOW_SKIP=1 make verify-all           # skips become non-fatal, still printed
```

## Verification-log entry template

Matches the `AGENTS.md` example entries:

```
### YYYY-MM-DD — critic — VERDICT: verified|refuted|needs-evidence
- <angle>: <what was attempted> — <exact command> → <observed output>. HELD|BROKEN.
- <novel angle>: <attempt> → <observed>. HELD|BROKEN.
- <if refuted> DEMAND: <the single concrete change required>.
Commands: <the exact commands run>
```

Rules:
- **Predict, then verify.** State the expected output before running; a surprise is a
  finding.
- **Exact commands + observed output**, not summaries — the log must be reproducible.
- **Every finding cites a point**: a Replay point link, an event-log offset + digest, a
  golden fixture path, or a diff hunk. A finding without a citation anyone can jump to
  is not a finding.
- **Coverage refutations count.** "The code is correct but no committed test would catch
  a regression" is a valid `refuted`.
- One verdict per entry; re-verification after rework gets its own entry.

## Meta-integrity

`make _v-meta` runs `tools/verify/self_check.sh`, which fails if any
implemented/verified task lacks a verify target or if any verify path contains a
green-washing escape (`|| true`, `continue-on-error`, or a `-` ignore-errors recipe
prefix — in the Makefile verify section, tools/verify scripts, GitHub workflows, or
package.json scripts). The verifier's own honesty is itself verified.

## Epic 3 canopy corpus

`make seed-canopy OUT=/absolute/scratch/path` starts the pinned Auth0 emulator and
published Durable Streams test server on ephemeral ports, dispatches the named canopy
through the public E0–E2 APIs, and writes canonical dumps plus `manifest.json` to the
requested scratch path. `make verify-E3-seed` seeds twice under hostile locale/timezone
settings, byte-compares both runs with the committed corpus, independently replays every
manifest entry, checks exact stream inventory and privacy/refusal transcripts, and runs
localized mutation checks.

The committed corpus is frozen. `make verify-E3-seed` never updates it. A deliberate
change uses `make regen-E3-seed`, which regenerates the evidence and prints the review
diff. Review every changed offset and digest before committing it. Run
`tools/verify/cold_clone.sh verify-E3-T01` against the exact candidate commit for the
final proof.
