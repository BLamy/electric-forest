import { describe, expect, it } from "vitest";
import type { Event } from "@eforest/protocol";
import {
  labelInitialState,
  labelReducer,
  LabelRefusalError,
  LabelSchemaError,
  validateLabelEvent,
} from "../src/labelReducer.js";

function event(type: string, payload: Record<string, unknown>, ts = 1): Event {
  return { type, payload, ts };
}

describe("repo-labels v1", () => {
  it("reduces create, rename, and recolor without changing identity", () => {
    const created = labelReducer(
      labelInitialState,
      event("label.created", { v: 1, labelId: "bug", name: "Bug", color: "#f00" }),
    );
    const renamed = labelReducer(
      created,
      event("label.renamed", { v: 1, labelId: "bug", name: "Defect" }),
    );
    const recolored = labelReducer(
      renamed,
      event("label.recolored", { v: 1, labelId: "bug", color: "#d00" }),
    );
    expect(recolored).toEqual({
      v: 1,
      labels: { bug: { name: "Defect", color: "#d00" } },
    });
  });

  it("enforces every refusal and exact-byte name uniqueness", () => {
    const state = labelReducer(
      labelInitialState,
      event("label.created", { v: 1, labelId: "bug", name: "Bug", color: "red" }),
    );
    expect(() =>
      validateLabelEvent(
        state,
        event("label.created", { v: 1, labelId: "bug", name: "Other", color: "blue" }),
      ),
    ).toThrowError(new LabelRefusalError("label/duplicate-id"));
    expect(() =>
      validateLabelEvent(
        state,
        event("label.created", { v: 1, labelId: "other", name: "Bug", color: "blue" }),
      ),
    ).toThrowError(new LabelRefusalError("label/duplicate-name"));
    expect(() =>
      validateLabelEvent(state, event("label.renamed", { v: 1, labelId: "missing", name: "Nope" })),
    ).toThrowError(new LabelRefusalError("label/unknown-id"));
    expect(() =>
      validateLabelEvent(
        state,
        event("label.recolored", { v: 1, labelId: "missing", color: "black" }),
      ),
    ).toThrowError(new LabelRefusalError("label/unknown-id"));
    const caseVariant = labelReducer(
      state,
      event("label.created", { v: 1, labelId: "case", name: "bug", color: "green" }),
    );
    expect(caseVariant.labels.case?.name).toBe("bug");
    expect(() =>
      validateLabelEvent(
        caseVariant,
        event("label.renamed", { v: 1, labelId: "case", name: "Bug" }),
      ),
    ).toThrowError(new LabelRefusalError("label/duplicate-name"));
  });

  it("throws on malformed and dispatch-refusable replay records", () => {
    expect(() =>
      labelReducer(
        labelInitialState,
        event("label.created", { v: 1, labelId: "bad id", name: "Bad", color: "red" }),
      ),
    ).toThrow(LabelSchemaError);
    expect(() =>
      [
        event("label.created", { v: 1, labelId: "x", name: "X", color: "red" }),
        event("label.created", { v: 1, labelId: "x", name: "Again", color: "blue" }),
      ].reduce(labelReducer, labelInitialState),
    ).toThrowError(new LabelRefusalError("label/duplicate-id"));
  });
});
