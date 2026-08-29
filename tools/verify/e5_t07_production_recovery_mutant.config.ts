import { mergeConfig, defineConfig } from "vitest/config";
import base from "../../vitest.config.ts";

const marker = "E5_T07_PRODUCTION_RECOVERY_BOUNDARY";
const guard = `await gateway.recoverPrOpenedGrantOperation(
          operationId,
          operation.streamId,
          operation.event,
        );`;
const bypass = `await writers.recover(operationId, operation.streamId, operation.event);
        // E5-T07 production recovery mutant`;

export default mergeConfig(
  base,
  defineConfig({
    plugins: [
      {
        name: "e5-t07-bypass-production-recovery-boundary",
        enforce: "pre",
        transform(code, rawId) {
          const id = rawId.split("?", 1)[0];
          if (!id?.endsWith("/packages/platform/src/production.ts")) return undefined;
          if (!code.includes(marker)) {
            throw new Error(`E5-T07 mutation marker missing: ${marker}`);
          }
          const occurrences = code.split(guard).length - 1;
          if (occurrences !== 1) {
            throw new Error(
              `E5-T07 expected one production recovery boundary, observed ${String(occurrences)}`,
            );
          }
          return { code: code.replace(guard, bypass), map: null };
        },
      },
    ],
  }),
);
