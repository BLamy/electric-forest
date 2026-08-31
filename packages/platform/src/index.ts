export {
  BearerVerifier,
  UnauthorizedError,
  type BearerVerifierOptions,
  type RequestIdentity,
  type UnauthorizedReason,
} from "./auth.js";
export {
  bearerToken,
  GrantAwareVerifier,
  tokenHash,
  TokenRevokedError,
  type AuthorizationContext,
  type AuthorizationVerifier,
} from "./auth/grants.js";
export {
  classifyDispatchTarget,
  decideStreamAuthorization,
  isAuthzBranch,
  isAuthzName,
  repoStreamId,
  repoTargetFromPath,
  type AuthzAllowed,
  type AuthzBasis,
  type AuthzDecision,
  type AuthzEventKind,
  type AuthzInput,
  type AuthzOperation,
  type AuthzPrincipal,
  type AuthzRefusalReason,
  type AuthzRefused,
  type AuthzTarget,
} from "./authz/decide.js";
export { AuthzViewUnavailableError, NamespaceViewReader } from "./authz/view.js";
export {
  PlatformGateway,
  createPlatformHandler,
  type PlatformGatewayOptions,
  type PlatformPrMergeOptions,
} from "./gateway.js";
export {
  OfficialStreamAdapter,
  StreamForkExistsError,
  StreamForkValidationError,
  type OfficialStreamAdapterOptions,
  type StreamAdapter,
  type StreamAppendResult,
  type StreamForkOptions,
} from "./official.js";
export {
  AuthRefusedError,
  OidcClient,
  OidcTransactions,
  pkceChallenge,
  type AuthRefusalReason,
  type OidcClaims,
  type OidcClientOptions,
  type OidcTransaction,
} from "./auth/oidc.js";
export {
  GrantOperationAbortedError,
  IdentityConflictError,
  IdentityDispatchRefusedError,
  IdentityStore,
  type IdentitySnapshot,
  type IdentityStoreOptions,
} from "./auth/provision.js";
export {
  clearedSessionCookie,
  parseSessionCookie,
  sessionIsValid,
  signedSessionCookie,
  SESSION_COOKIE,
  type CookieResult,
} from "./auth/session.js";
export { authRefusalResponse, PlatformWebApp, type PlatformWebAppOptions } from "./auth/routes.js";
export {
  resolveSessionBackedIdentity,
  whoamiResponse,
  type SessionBackedIdentity,
  type WhoamiOptions,
} from "./api/whoami.js";
export {
  PROOF_RECEIPT_SHELL_MARKER,
  SESSION_SHELL_MARKER,
  spaResponse,
  type SpaHandlerOptions,
} from "./web/spa.js";
export {
  PLATFORM_RATE_LIMIT_KEYS,
  PLATFORM_ROUTES,
  PUBLIC_SITE_ROUTES,
  classifyPlatformRoute,
  isPublicSiteRoute,
  type PlatformRouteDefinition,
  type PlatformRouteId,
} from "./route-topology.js";
export {
  DEFAULT_PLATFORM_RATE_LIMIT,
  FixedWindowRateLimiter,
  RateLimitExceededError,
  rateLimitKey,
  rateLimitResponse,
  type FixedWindowRateLimitOptions,
  type RateLimitAllowance,
  type RateLimitDecision,
  type RateLimitKey,
  type RateLimitOperation,
  type RateLimitRefusal,
} from "./rate-limit.js";
export { activeTenants, decideTenantAccess, type TenantDecision } from "./tenant-isolation.js";
export {
  RepositoryHomeCorruptError,
  RepositoryHomeNativeForkError,
  RepositoryHomeStore,
  type RepositoryHomeBatch,
  type RepositoryHomeRegion,
} from "./repo-home.js";
export {
  createPlatformServer,
  listenPlatformServer,
  type PlatformRequestHandler,
} from "./server.js";
export {
  createPlatformProductionRuntime,
  readPlatformEnvironment,
  type PlatformEnvironment,
  type PlatformProductionRuntimeOptions,
  type PlatformProductionRuntime,
} from "./production.js";
export {
  isNamespaceDispatchEvent,
  isNamespaceEvent,
  isNamespaceEventType,
  isNamespaceName,
  stampNamespaceEvent,
  type NamespaceActor,
  type NamespaceEvent,
  type NamespaceEventType,
  type NamespaceVisibility,
} from "./ns/events.js";
export {
  composeNamespaceView,
  createNamespaceInitialState,
  namespaceReducer,
  replayNamespaceStream,
  type NamespaceOrgView,
  type NamespaceStreamState,
  type NamespaceView,
} from "./ns/reducer.js";
export { namespaceViewDigest } from "./namespace-digest.js";
export {
  resolvePath,
  type NamespaceNotFound,
  type NamespaceResolution,
  type ResolvedOrg,
  type ResolvedRepo,
} from "./ns/resolve.js";
export {
  NamespaceContentionError,
  NamespaceDispatcher,
  NamespaceRefusalError,
  NamespaceSchemaError,
  type NamespaceRefusalReason,
} from "./ns/dispatch.js";
export {
  reduceWriterLanes,
  stampWriterEvent,
  WriterLaneContentionError,
  WriterLaneCorruptionError,
  WriterLaneDispatcher,
  WriterLaneRefusalError,
  WRITER_LANE_VERSION,
  type WriterDispatchOptions,
  type WriterDispatchReceipt,
  type WriterLane,
  type WriterLaneState,
  type WriterScopedEvent,
  type WriterScopedPayload,
} from "./writer-lanes.js";
export { NS_NAME_RE } from "./ns/events.js";
export * from "./issues/index.js";
export { PrIndexMaterializer } from "./pr/index-store.js";
export {
  boardCachePath,
  IssueBoardMaterializer,
  type BoardEndpointBody,
  type BoardInputProvenance,
  type BoardProvenance,
  type IssueBoardMaterializerOptions,
} from "./issues/board-store.js";
export * from "./loop/index.js";
export {
  ActionValidatorRegistry,
  registerApplicationValidators,
  registerIssueValidators,
  registerLabelValidators,
  registerPrValidators,
  registerProjectValidators,
  type ActionValidationContext,
  type ActionValidator,
} from "./validation.js";
export {
  isRegistryEvent,
  isRegistryEventType,
  type RegistryEvent,
  type RegistryEventType,
  type RegistrySource,
} from "./registry/events.js";
export {
  projectSourceEvent,
  RegistryProjectionError,
  RegistryProjector,
  REGISTRY_STREAM,
  type RegistryProjectorOptions,
} from "./registry/projector.js";
export {
  registryInitialState,
  registryReducer,
  registryStateDigest,
  replayRegistryStream,
  type RegistryOrgState,
  type RegistryProjectState,
  type RegistryRepoState,
  type RegistryState,
} from "./registry/reducer.js";
export {
  filterForIdentity,
  isRegistryOrgRelation,
  registryEntries,
  restrictToOwnRelations,
  type RegistryEntry,
} from "./registry/filter.js";
export {
  authorizedRegistryProjection,
  frameVisible,
  parseRegistryRecord,
  registryApplicationProjectionResponse,
  registryLongPollResponse,
  registrySnapshotResponse,
  registrySseResponse,
  RegistryStreamCorruptError,
  type RegistryRecord,
  type RegistryScope,
} from "./registry/doors.js";
export {
  rebuildRegistry,
  RegistryPresentError,
  type RegistryRebuildResult,
  type RegistryStoreSurface,
} from "./registry/rebuild.js";
