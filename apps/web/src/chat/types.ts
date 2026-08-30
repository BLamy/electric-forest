import type { DispatchFunction, StreamReducerResult } from "@eforest/web-hooks";
import type { ChatCatalogState, ChatChannelState } from "@eforest/reducers";

export type { ChatCatalogState, ChatChannelState, ChatMessage } from "@eforest/reducers";

export interface ChatCatalogBinding {
  readonly streamId: string;
  readonly projection: StreamReducerResult<ChatCatalogState>;
  readonly dispatch: DispatchFunction;
}

export interface ChatChannelBinding {
  readonly streamId: string;
  readonly projection: StreamReducerResult<ChatChannelState>;
  readonly dispatch: DispatchFunction;
}
