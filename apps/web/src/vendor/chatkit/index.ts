/* Vendored @touchkit/chatkit (github.com/blamy/ui @ b7e037c) — public surface used by the app. */
import "./styles.css";

export { ChatIcon, chatIconPaths } from "./chat-icon.js";
export { chatTokens, chatTokenVars, K, KFONT, KMONO, KEASE } from "./chat-tokens.js";
export { kvib } from "./kvib.js";
export {
  ChatUsersProvider,
  useChatUsers,
  type ChatUser,
  type ChatUsers,
  type ChatChannel,
  type ChatChannels,
  type ChatMessageData,
} from "./chat-users.js";
export { ChatAvatar } from "./chat-avatar.js";
export { Message } from "./message.js";
export { Composer } from "./composer.js";
export { ThreadPreview } from "./thread-preview.js";
export { RichText } from "./rich-text.js";
export { ChannelList, type ChannelListProps } from "./channel-list.js";
export { WorkspaceRail, type Workspace, type WorkspaceRailProps } from "./workspace-rail.js";
export { ChatShell, useChatShell } from "./chat-shell.js";
