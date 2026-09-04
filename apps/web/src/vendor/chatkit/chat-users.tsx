/* Vendored from github.com/blamy/ui touchkit/packages/chatkit/src/lib/chat-users.tsx @ b7e037c (2026-08-29).
   @touchkit/chatkit is unpublished; keep edits minimal and mark them with "ef:" comments. */
import { createContext, use, type ReactNode } from "react";

export interface ChatUser {
  name: string;
  /** avatar/base color */
  c: string;
  /** name label color */
  role: string;
  bot?: boolean;
}

export type ChatUsers = Record<string, ChatUser>;

export type ChatReaction = [string, number, boolean];

export interface ChatThreadReply {
  id: string;
  u: string;
  t: string;
  txt: string;
  reacts?: ChatReaction[];
}

export interface ChatThreadData {
  title: string;
  msgs: ChatThreadReply[];
}

export interface ChatMessageData {
  id: string;
  u: string;
  t: string;
  txt: string;
  reacts: ChatReaction[];
  thread?: ChatThreadData | null;
}

export interface ChatChannel {
  section: string;
  label: string;
  unread?: boolean;
  msgs: ChatMessageData[];
}

export type ChatChannels = Record<string, ChatChannel>;

const ChatUsersCtx = createContext<ChatUsers>({});

export interface ChatUsersProviderProps {
  users: ChatUsers;
  children?: ReactNode;
}

export function ChatUsersProvider({ users, children }: ChatUsersProviderProps) {
  return <ChatUsersCtx.Provider value={users}>{children}</ChatUsersCtx.Provider>;
}

export function useChatUsers(): ChatUsers {
  return use(ChatUsersCtx);
}
