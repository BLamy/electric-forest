import { isDurableNotFound } from "@eforest/client";
import { NamespaceRuntime } from "../namespace-runtime.js";
import type { NamespaceView } from "../ns/reducer.js";
import type { StreamAdapter } from "../official.js";

/**
 * Raised when the namespace view cannot be replayed for an authorization
 * decision. The gateway fails CLOSED on this error: no operation proceeds
 * without a decision, and nothing is appended.
 */
export class AuthzViewUnavailableError extends Error {
  constructor(cause: unknown) {
    super("authorization namespace view unavailable", { cause });
    this.name = "AuthzViewUnavailableError";
  }
}

/**
 * Replays the E2-T06 namespace streams into the view `decide` consumes.
 *
 * Replay executes inside the E2-T06 permission-denied namespace runtime child
 * (the same boundary the dispatcher uses), never in-process. Only the two
 * view streams are read — `ns:root` and, when the org is recorded there,
 * `ns:org:<name>` — and a missing stream replays as empty, so consulting the
 * view performs no operation on any target stream and can never mint one.
 */
export class NamespaceViewReader {
  private readonly streams: StreamAdapter;
  private readonly runtime: NamespaceRuntime;

  constructor(streams: StreamAdapter, runtime?: NamespaceRuntime) {
    this.streams = streams;
    this.runtime = runtime ?? new NamespaceRuntime();
  }

  /** The namespace view scoped to one org (absent org ⇒ empty view). */
  async viewFor(orgName: string): Promise<NamespaceView> {
    try {
      const root = await this.runtime.replay(await this.readOrEmpty("ns:root"));
      if (!Object.hasOwn(root.orgs, orgName)) return { orgs: {} };
      const owner = root.orgs[orgName]!.owner;
      const local = await this.runtime.replay(await this.readOrEmpty(`ns:org:${orgName}`));
      return {
        orgs: { [orgName]: { owner, projects: local.projects, repos: local.repos } },
      };
    } catch (error) {
      throw new AuthzViewUnavailableError(error);
    }
  }

  terminate(): void {
    this.runtime.terminate();
  }

  private async readOrEmpty(streamId: string): Promise<readonly unknown[]> {
    try {
      return await this.streams.read(streamId);
    } catch (error) {
      if (isDurableNotFound(error)) return [];
      throw error;
    }
  }
}
