import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { replay, type Event } from "@eforest/protocol";
import { describe, expect, test } from "vitest";
import {
  emptyView,
  findActiveGrantByTokenHash,
  identityReducer,
  isSessionActive,
  roleOf,
  userForSub,
  viewDigest,
} from "../src/index.js";
import {
  grant,
  grantRevoke,
  membership,
  membershipRevoke,
  oracleFold,
  org,
  session,
  sessionEnd,
  user,
  xorshift,
} from "./helpers.js";

const root = resolve(import.meta.dirname, "../../..");
const evidence = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/evidence/ordering-properties.json",
);
const counts = JSON.parse(readFileSync(evidence, "utf8")) as {
  independentInterleavings: number;
  preconditionViolations: number;
  seed: number;
  validHistories: number;
};

function mergePreservingOrder(
  left: readonly Event[],
  right: readonly Event[],
  random: () => number,
): Event[] {
  const result: Event[] = [];
  let l = 0;
  let r = 0;
  while (l < left.length || r < right.length) {
    if (r >= right.length || (l < left.length && (random() & 1) === 0)) result.push(left[l++]!);
    else result.push(right[r++]!);
  }
  return result;
}

function lane(index: number, suffix: string): Event[] {
  const sub = `auth0|user-${index}-${suffix}`;
  const orgId = `org-${index}-${suffix}`;
  const grantId = `grant-${index}-${suffix}`;
  const sessionId = `session-${index}-${suffix}`;
  const hash = (suffix === "a" ? "a" : "b").repeat(60) + index.toString(16).padStart(4, "0");
  return [
    user(sub),
    org(orgId, sub),
    grant(grantId, sub, hash),
    session(sessionId, sub),
    sessionEnd(sessionId),
  ];
}

describe("identity ordering properties", () => {
  test("500 generated valid histories agree with an independent oracle and queries", () => {
    expect(counts.validHistories).toBeGreaterThanOrEqual(500);
    const random = xorshift(counts.seed);
    for (let index = 0; index < counts.validHistories; index += 1) {
      const owner = `auth0|owner-${index}`;
      const member = `auth0|member-${index}`;
      const orgId = `org-${index}`;
      const grantId = `grant-${index}`;
      const hash = `${(random() & 15).toString(16)}`.repeat(64);
      const events: Event[] = [
        user(owner),
        user(member),
        org(orgId, owner),
        membership(orgId, member),
      ];
      const membershipMode = random() % 3;
      if (membershipMode === 0) {
        events.push(membershipRevoke(orgId, member));
      } else if (membershipMode === 1) {
        events.push(membershipRevoke(orgId, member), membership(orgId, member, "admin"));
      }
      events.push(grant(grantId, member, hash));
      if ((random() & 1) === 0) events.push(grantRevoke(grantId));
      const sessionId = `session-${index}`;
      events.push(session(sessionId, member));
      if ((random() & 1) === 0) events.push(sessionEnd(sessionId));
      const actual = replay(events, identityReducer, emptyView());
      const expected = oracleFold(events);
      expect(actual, `seed=${counts.seed} history=${index}`).toEqual(expected);
      expect(userForSub(actual, owner)).toEqual(expected.users[owner]);
      expect(roleOf(actual, orgId, owner)).toBe("owner");
      expect(roleOf(actual, orgId, member)).toBe(
        expected.memberships[orgId]?.[member]?.status === "active"
          ? expected.memberships[orgId]?.[member]?.role
          : null,
      );
      expect(findActiveGrantByTokenHash(actual, hash)?.grantId ?? null).toBe(
        expected.grants[grantId]?.status === "active" ? grantId : null,
      );
      expect(isSessionActive(actual, sessionId)).toBe(
        expected.sessions[sessionId]?.status === "active",
      );
    }
  });

  test("500 independent-entity interleavings have one canonical digest", () => {
    expect(counts.independentInterleavings).toBeGreaterThanOrEqual(500);
    const random = xorshift(counts.seed ^ 0x5f3759df);
    for (let index = 0; index < counts.independentInterleavings; index += 1) {
      const left = lane(index, "a");
      const right = lane(index, "b");
      const expected = viewDigest(replay([...left, ...right], identityReducer, emptyView()));
      const interleaved = mergePreservingOrder(left, right, random);
      expect(
        viewDigest(replay(interleaved, identityReducer, emptyView())),
        `seed=${counts.seed} history=${index}`,
      ).toBe(expected);
    }
  });

  test("500 precondition-violating reorderings fail deterministically", () => {
    expect(counts.preconditionViolations).toBeGreaterThanOrEqual(500);
    for (let index = 0; index < counts.preconditionViolations; index += 1) {
      const sub = `auth0|invalid-${index}`;
      const cases: readonly Event[][] = [
        [grantRevoke(`grant-${index}`), user(sub), grant(`grant-${index}`, sub, "a".repeat(64))],
        [membership(`org-${index}`, sub), user(sub), org(`org-${index}`, sub)],
        [sessionEnd(`session-${index}`), user(sub), session(`session-${index}`, sub)],
      ];
      expect(
        () => replay(cases[index % cases.length]!, identityReducer, emptyView()),
        `seed=${counts.seed} history=${index}`,
      ).toThrow();
    }
  });
});
