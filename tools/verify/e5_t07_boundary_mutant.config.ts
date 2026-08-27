import { mergeConfig, defineConfig } from "vitest/config";
import base from "../../vitest.config.ts";

const marker = "E5_T07_PRECOMMIT_TARGET_BOUNDARY";
const guard = "await validatePrOpenedLinkTargets(this.streams, parsed.streamId, parsed.event);";

export default mergeConfig(
  base,
  defineConfig({
    plugins: [
      {
        name: "e5-t07-remove-precommit-target-boundary",
        enforce: "pre",
        transform(code, rawId) {
          const id = rawId.split("?", 1)[0];
          if (!id?.endsWith("/packages/platform/src/gateway.ts")) return undefined;
          if (!code.includes(marker)) {
            throw new Error(`E5-T07 mutation marker missing: ${marker}`);
          }
          const occurrences = code.split(guard).length - 1;
          if (occurrences !== 1) {
            throw new Error(`E5-T07 expected one precommit guard, observed ${String(occurrences)}`);
          }
          return {
            code: code.replace(guard, "void parsed.event; // E5-T07 boundary mutant"),
            map: null,
          };
        },
      },
    ],
  }),
);
