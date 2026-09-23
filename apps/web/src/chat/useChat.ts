import { useDispatch, useStreamReducer } from "@eforest/web-hooks";
import {
  CHAT_CATALOG_REDUCER,
  CHAT_CHANNEL_REDUCER,
  chatCatalogStreamId,
  chatChannelStreamId,
  type ChatCatalogState,
  type ChatChannelState,
} from "@eforest/reducers";
import type { ChatCatalogBinding, ChatChannelBinding } from "./types.js";

function encoded(value: string): string {
  return encodeURIComponent(value);
}

/** The workspace's channel catalog (`chat:<org>`), followed live. */
export function useChatCatalog(org: string): ChatCatalogBinding {
  const streamId = chatCatalogStreamId(org);
  const projection = useStreamReducer<ChatCatalogState>({
    apiPath: `/api/chat/${encoded(org)}`,
    streamId,
    reducerId: CHAT_CATALOG_REDUCER,
    // A long-poll returns the moment a new event lands, so a long wait costs no
    // latency; short waits only burn the per-org follow budget (1000/min).
    followWaitMs: 10_000,
    reconnectDelayMs: 1_000,
  });
  const dispatch = useDispatch(streamId, { replayedOffset: projection.checkpoint });
  return { streamId, projection, dispatch };
}

/** One channel's message stream (`chat:<org>/<channel>`), followed live. */
export function useChatChannel(
  org: string,
  channel: string,
): ChatChannelBinding & { readonly topic: string } {
  const streamId = chatChannelStreamId(org, channel);
  const projection = useStreamReducer<ChatChannelState>({
    apiPath: `/api/chat/${encoded(org)}/${encoded(channel)}`,
    streamId,
    reducerId: CHAT_CHANNEL_REDUCER,
    followWaitMs: 10_000,
    reconnectDelayMs: 1_000,
  });
  const dispatch = useDispatch(streamId, { replayedOffset: projection.checkpoint });
  // The topic comes from the catalog the shell already follows; a one-shot read
  // here avoids a second live subscription per open channel.
  const catalog = useStreamReducer<ChatCatalogState>({
    apiPath: `/api/chat/${encoded(org)}`,
    streamId: chatCatalogStreamId(org),
    reducerId: CHAT_CATALOG_REDUCER,
    follow: false,
  });
  const topic = catalog.state.channels[channel]?.topic ?? "";
  return { streamId, projection, dispatch, topic };
}
