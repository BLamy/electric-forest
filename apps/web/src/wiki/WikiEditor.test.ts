import { describe, expect, it } from "vitest";
import { shouldAdoptWikiSource } from "./WikiEditor.js";

describe("wiki editor source adoption", () => {
  const loaded = { revision: "offset-2", text: "# Home\n" } as const;

  it("hydrates once without repeatedly replacing an unchanged clean draft", () => {
    expect(shouldAdoptWikiSource(undefined, loaded.revision, loaded.text, false, undefined)).toBe(
      true,
    );
    expect(shouldAdoptWikiSource(loaded, loaded.revision, loaded.text, false, undefined)).toBe(
      false,
    );
  });

  it("adopts a changed server source only while clean and not awaiting replay", () => {
    expect(shouldAdoptWikiSource(loaded, "offset-3", "# Home\nnew\n", false, undefined)).toBe(true);
    expect(shouldAdoptWikiSource(loaded, "offset-3", "# Home\nnew\n", true, undefined)).toBe(false);
    expect(shouldAdoptWikiSource(loaded, "offset-3", "# Home\nnew\n", false, "offset-3")).toBe(
      false,
    );
  });
});
