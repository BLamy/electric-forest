export { runCli, type CliIo } from "./cli.js";
export {
  CLONE_USAGE,
  COMPLETE_MARKER,
  CloneCliError,
  runClone,
  runWorkspaceCheck,
  WORKSPACE_CHECK_USAGE,
  type CloneErrorCode,
} from "./clone-command.js";
export {
  bearerHeaders,
  clearCredentials,
  credentialsDirectory,
  credentialsPath,
  loadCredentials,
  NO_CREDENTIALS_MESSAGE,
  storeCredentials,
  type StoredCredentials,
} from "./credentials.js";
export {
  DEVICE_DENIED_EXIT,
  DEVICE_EXPIRED_EXIT,
  runLogin,
  type LoginDependencies,
} from "./commands/login.js";
export { runAuthenticatedDispatch } from "./dispatch-command.js";
export { runTreeDigest, TREE_DIGEST_USAGE } from "./worktree-command.js";
export {
  STATUS_HEAD_TIMEOUT_MS,
  STATUS_JSON_VERSION,
  STATUS_USAGE,
  StatusCliError,
  probeBranchHead,
  runStatus,
  type BranchHead,
  type StatusDependencies,
  type StatusErrorCode,
  type StatusJson,
} from "./status.js";
export {
  BRANCH_USAGE,
  CHECKOUT_USAGE,
  BranchCheckoutCliError,
  runBranch,
  runCheckout,
  checkoutMarkerPath,
  type BranchCheckoutDependencies,
  type BranchCheckoutErrorCode,
} from "./branch-checkout-command.js";
export { classifyWorkingTree, compareUtf8, type WorkingTreeClassification } from "./classify.js";
export {
  INIT_ALREADY_INITIALIZED_EXIT,
  INIT_DIGEST_MISMATCH_EXIT,
  INIT_NO_CREDENTIALS_EXIT,
  INIT_WORKSPACE_PATH_CONFLICT_EXIT,
  INIT_USAGE,
  InitCliError,
  runInit,
} from "./init-command.js";
export {
  uploadTree,
  type TreeUploadOptions,
  type TreeUploadResult,
  type TreeUploadTransport,
} from "./sync/tree-upload.js";
export {
  DEFAULT_UPLINK_DEBOUNCE_MS,
  UplinkEngine,
  UplinkError,
  WATCH_USAGE,
  runWatch,
  type UplinkDispatchStartNotice,
  type UplinkUploadedNotice,
  type UplinkDispatchReceipt,
  type UplinkDispatchRefusal,
  type UplinkEngineOptions,
  type UplinkQuiescence,
  type WatchDependencies,
} from "./sync/uplink.js";
export {
  coalesce,
  isExcludedUplinkPath,
  sortUplinkPlan,
  type PendingFsEvent,
  type PendingFsEventKind,
  type UplinkLedgerView,
  type UplinkPlanEntry,
  type UplinkPlanKind,
} from "./sync/coalesce.js";
export {
  DOWNLINK_USAGE,
  DownlinkEngine,
  DownlinkError,
  runDownlinkWatch,
  runJournalVerify,
  type DownlinkApplyNotice,
  type DownlinkEngineOptions,
  type DownlinkErrorCode,
  type DownlinkPhase,
  type DownlinkWatchDependencies,
} from "./sync/downlink.js";
export { DuplexWatchEngine, DuplexWatchError, type DuplexEngineOptions } from "./sync/duplex.js";
export {
  decisionLine,
  isAfter,
  planUplink,
  reconcile,
  repairJournal,
  type ReconcileClient,
  type ReconcileDecision,
  type ReconcileSummary,
  type UplinkPlanEntry as ReconcileUplinkPlanEntry,
} from "./sync/reconcile.js";
export {
  SYNC_JOURNAL_NAME,
  SYNC_JOURNAL_VERSION,
  SyncJournalError,
  SyncJournalWriter,
  readSyncJournal,
  syncJournalPath,
  type SyncDisposition,
  type SyncJournalRecord,
} from "./sync/sync-journal.js";
export {
  WATCH_COMMAND_USAGE,
  WATCH_START_TIMEOUT_MS,
  WatchCommandError,
  runWatchCommand,
  type WatchCommandDependencies,
  type WatchCommandErrorCode,
} from "./sync/watch-command.js";
export {
  WATCH_DIVERGENCE_NAME,
  WATCH_PID_NAME,
  WATCH_READY_NAME,
  isProcessAlive,
  readWatchPid,
  readWatchState,
  watchDivergencePath,
  watchPidPath,
  watchReadyPath,
  type WatchState,
} from "./sync/watch-state.js";
export {
  APPLY_INTENT_NAME,
  APPLY_BASE_NAME,
  APPLY_JOURNAL_NAME,
  APPLY_JOURNAL_VERSION,
  ApplyJournalError,
  ApplyJournalWriter,
  captureWorktreeSnapshot,
  intentPath,
  applyBasePath,
  readApplyBase,
  journalPath,
  readApplyIntent,
  readApplyJournal,
  restoreWorktreeSnapshot,
  snapshotDigest,
  verifyApplyJournal,
  writeApplyBase,
  type ApplyBase,
  type ApplyIntent,
  type ApplyIntentInput,
  type ApplyJournalPathDigest,
  type ApplyJournalProvenance,
  type ApplyJournalRecord,
  type WorktreeSnapshot,
} from "./sync/apply-journal.js";
export {
  JournalWriter,
  journalLine,
  readJournal,
  type AcceptedJournalRecord,
  type JournalAction,
  type JournalConflict,
  type JournalRecord,
  type RefusedJournalRecord,
} from "./sync/journal.js";
export { materializeDump } from "./materialize-command.js";
export { snapshotOutput, snapshotStreamUrl } from "./snapshot-command.js";
export {
  bisectFiles,
  bisectRecords,
  runBisect,
  type BisectKind,
  type BisectOptions,
  type BisectResult,
  type BisectStats,
} from "./bisect-command.js";
export {
  defaultInitialState,
  digestRecords,
  iterateDump,
  loadReducer,
  readDump,
  replayDigest,
  bootstrapDigest,
  replayDigestLocal,
  replayBranchDigest,
  ReplayCliError,
  type DigestKind,
  type BranchReplayOptions,
  type DumpRecord,
  type ReadDumpOptions,
  type ReducerModule,
} from "./replay-command.js";
export {
  SESSION_MANIFEST_VERSION,
  SESSION_ROLES,
  SessionManifestError,
  parseSessionManifest,
  sessionDumpFileName,
  validateSession,
  type SessionDump,
  type SessionManifest,
  type SessionManifestEntry,
  type SessionManifestFailureCode,
  type SessionRecord,
  type SessionRole,
  type ValidatedSession,
} from "./session/manifest.js";
export {
  SessionReplayError,
  compositeDigest,
  replaySession,
  type CompositeDigestInput,
  type SessionLinkResult,
  type SessionReplayFailureCode,
  type SessionReplayResult,
  type SessionReducerDefinition,
  type SessionReducerResolver,
  type SessionStreamResult,
} from "./session/replay.js";
export {
  SessionDumpError,
  captureSession,
  loadSessionDirectory,
  replaySessionDirectory,
  runSessionCapture,
  runSessionReplay,
  type CaptureSessionOptions,
  type CaptureSessionResult,
  type SessionDumpFailureCode,
  type SessionReplayIo,
} from "./session/dump.js";
