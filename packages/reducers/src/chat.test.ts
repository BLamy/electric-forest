import { describe, expect, it } from "vitest";
import {
  chatCatalogInitialState,
  chatCatalogReducer,
  chatCatalogReducerDefinition,
  chatCatalogStreamId,
  chatChannelInitialState,
  chatChannelReducer,
  chatChannelReducerDefinition,
  chatChannelStreamId,
  isChatDispatchPayload,
  isChatEvent,
  parseChatStreamId,
  requireReducer,
} from "./index.js";

const create = (name: string, actor = "auth0|ada") => ({
  type: "chat.channel.create",
  payload: { v: 1, name, topic: "t", actor },
  ts: 1_780_000_000_000,
});
const post = (id: string, body: string, actor = "auth0|ada") => ({
  type: "chat.message.post",
  payload: { v: 1, id, body, actor },
  ts: 1_780_000_000_001,
  offset: "00000000000000000000_00000000000000000001",
});

describe("chat streams", () => {
  it("names org-scoped streams and resolves their reducers", () => {
    expect(parseChatStreamId(chatCatalogStreamId("maple"))).toEqual({
      org: "maple",
      channel: undefined,
    });
    expect(parseChatStreamId(chatChannelStreamId("maple", "general"))).toEqual({
      org: "maple",
      channel: "general",
    });
    expect(parseChatStreamId("chat:")).toBeUndefined();
    expect(parseChatStreamId("chat:Maple/General")).toBeUndefined();
    expect(requireReducer("chat-catalog", "chat:maple")).toBe(chatCatalogReducerDefinition);
    expect(requireReducer("chat-channel", "chat:maple/general")).toBe(chatChannelReducerDefinition);
    expect(() => requireReducer("chat-channel", "chat:maple")).toThrow();
    expect(() => requireReducer("issue", "chat:maple/general")).toThrow();
  });

  it("accepts exactly the client payload shapes and refuses everything else", () => {
    expect(isChatDispatchPayload("chat.channel.create", { v: 1, name: "general", topic: "" })).toBe(
      true,
    );
    expect(isChatDispatchPayload("chat.channel.create", { v: 1, name: "General", topic: "" })).toBe(
      false,
    );
    expect(
      isChatDispatchPayload("chat.channel.create", { v: 1, name: "general", topic: "", x: 1 }),
    ).toBe(false);
    expect(isChatDispatchPayload("chat.message.post", { v: 1, id: "m1", body: "hi" })).toBe(true);
    expect(isChatDispatchPayload("chat.message.post", { v: 1, id: "m1", body: "   " })).toBe(false);
    expect(isChatDispatchPayload("chat.message.post", { v: 1, id: "m1", body: "\uD800" })).toBe(
      false,
    );
    expect(isChatDispatchPayload("chat.message.post", { v: 2, id: "m1", body: "hi" })).toBe(false);
    // The committed shape needs the gateway-stamped actor.
    expect(isChatEvent(post("m1", "hi"))).toBe(true);
    expect(
      isChatEvent({ type: "chat.message.post", payload: { v: 1, id: "m1", body: "hi" }, ts: 1 }),
    ).toBe(false);
  });

  it("reduces idempotently and keeps the author in state", () => {
    let catalog = chatCatalogReducer(chatCatalogInitialState, create("general"));
    catalog = chatCatalogReducer(catalog, create("general", "auth0|bob"));
    expect(Object.keys(catalog.channels)).toEqual(["general"]);
    expect(catalog.channels["general"]?.createdBy).toBe("auth0|ada");

    let channel = chatChannelReducer(chatChannelInitialState, post("m1", "hello"));
    channel = chatChannelReducer(channel, post("m1", "hello again"));
    channel = chatChannelReducer(channel, post("m2", "second", "auth0|bob"));
    expect(channel.messages.map((message) => [message.id, message.actor, message.body])).toEqual([
      ["m1", "auth0|ada", "hello"],
      ["m2", "auth0|bob", "second"],
    ]);
    expect(channel.messages[0]?.offset).toBe("00000000000000000000_00000000000000000001");
    expect(channel.messages[0]).toMatchObject({ threadOf: null, revision: 1, deleted: false });
    // Foreign events never touch chat state.
    expect(chatChannelReducer(channel, create("x"))).toBe(channel);
    expect(chatCatalogReducerDefinition.digest(catalog)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("edits and deletes only by the author at the cited revision, and threads replies", () => {
    const edit = (id: string, body: string, expectedRevision: number, actor = "auth0|ada") => ({
      type: "chat.message.edit",
      payload: { v: 1, id, body, expectedRevision, actor },
      ts: 1_780_000_000_010,
    });
    const del = (id: string, expectedRevision: number, actor = "auth0|ada") => ({
      type: "chat.message.delete",
      payload: { v: 1, id, expectedRevision, actor },
      ts: 1_780_000_000_020,
    });
    let channel = chatChannelReducer(chatChannelInitialState, post("m1", "hello"));
    // stale / foreign / unknown edits are no-ops
    expect(chatChannelReducer(channel, edit("m1", "x", 2))).toBe(channel);
    expect(chatChannelReducer(channel, edit("m1", "x", 1, "auth0|bob"))).toBe(channel);
    expect(chatChannelReducer(channel, edit("nope", "x", 1))).toBe(channel);
    channel = chatChannelReducer(channel, edit("m1", "hello, edited", 1));
    expect(channel.messages[0]).toMatchObject({
      body: "hello, edited",
      revision: 2,
      editedAt: 1_780_000_000_010,
    });
    // replies reference a live root; nested replies are refused by the reducer too
    const reply = {
      type: "chat.message.post",
      payload: { v: 1, id: "r1", body: "reply", threadOf: "m1", actor: "auth0|bob" },
      ts: 1_780_000_000_015,
    };
    channel = chatChannelReducer(channel, reply);
    expect(channel.messages[1]).toMatchObject({ id: "r1", threadOf: "m1" });
    const nested = { ...reply, payload: { ...reply.payload, id: "r2", threadOf: "r1" } };
    expect(chatChannelReducer(channel, nested)).toBe(channel);
    // delete leaves a tombstone at the next revision; later edits are ignored
    channel = chatChannelReducer(channel, del("m1", 1));
    expect(channel.messages[0]?.deleted).toBe(false);
    channel = chatChannelReducer(channel, del("m1", 2));
    expect(channel.messages[0]).toMatchObject({ deleted: true, body: "", revision: 3 });
    expect(chatChannelReducer(channel, edit("m1", "zombie", 3))).toBe(channel);
    expect(
      isChatDispatchPayload("chat.message.post", { v: 1, id: "a", body: "b", threadOf: "a" }),
    ).toBe(false);
    expect(
      isChatDispatchPayload("chat.message.delete", { v: 1, id: "a", expectedRevision: 0 }),
    ).toBe(false);
  });
});
