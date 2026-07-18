# `ef` CLI credentials

`ef login [--no-browser]` performs RFC 8628 device authorization against
`EF_OIDC_ISSUER` / `EF_OIDC_CLIENT_ID`, registers the redeemed JWT as an event-backed
device grant at `EF_SERVER_URL`, and writes `$EF_HOME/credentials.json` (default
`~/.eforest/credentials.json`) with mode `0600`. Polling honors the issuer interval;
`slow_down` increases it by at least five seconds. `ef logout` deletes the file.

Every authenticated command loads credentials before making a request and injects the
Bearer header. `ef dispatch <stream-id> <event-json>` is the first such command. Missing
credentials are refused locally, including when the platform is unreachable.

## Frozen exit codes

| exit code | meaning                                                  |
| --------: | -------------------------------------------------------- |
|       `0` | success                                                  |
|      `10` | no credentials; no request made                          |
|      `11` | device flow `expired_token`                              |
|      `12` | device flow `access_denied`                              |
|      `13` | server refused the presented credential with a typed 401 |

## Platform refusal classes

| class                   | status |
| ----------------------- | -----: |
| `token-revoked`         |    401 |
| `web-session-required`  |    401 |
| `grant-already-revoked` |    409 |
| `grant-not-found`       |    404 |
