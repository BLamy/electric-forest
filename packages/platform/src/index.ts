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
export { PlatformGateway, createPlatformHandler, type PlatformGatewayOptions } from "./gateway.js";
export {
  OfficialStreamAdapter,
  type OfficialStreamAdapterOptions,
  type StreamAdapter,
  type StreamAppendResult,
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
  createPlatformServer,
  listenPlatformServer,
  type PlatformRequestHandler,
} from "./server.js";
export {
  createPlatformProductionRuntime,
  readPlatformEnvironment,
  type PlatformEnvironment,
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
