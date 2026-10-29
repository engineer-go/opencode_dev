# Diagnose OpenCode free and Go requests

Run from `packages/opencode`. The probe runs a fresh CLI session in a temporary
directory and observes its actual HTTP request through a loopback proxy. It
forces the selected provider/model, disables tools and sharing, and forwards at most one
request. It does not modify saved credentials or configuration.

```sh
# Offline: fake SSE response, real CLI/provider/request construction
bun script/go-probe.ts
bun script/go-probe.ts --provider opencode

# Free model: one live request, including quota/version rejection diagnostics
bun script/go-probe.ts --live --provider opencode --model nemotron-3.5-lightning-free

# Test a specific compiled CLI executable (must accept `run`)
bun script/go-probe.ts --cli /absolute/path/to/opencode

# Live: uses the existing Go login or OPENCODE_API_KEY; may consume quota
bun script/go-probe.ts --live --model deepseek-v4.1-flash
bun script/go-probe.ts --live --cli /absolute/path/to/opencode --model deepseek-v4.1-flash

# Framework tests
bun test test/provider/go-probe.test.ts
```

The source CLI normally reports `opencode/local`; package.json version changes
do not change the compile-time `OPENCODE_VERSION`. Compare its `request.userAgent`
with the compiled executable. A desktop Node bundle is not a CLI executable;
this harness does not launch or inspect the desktop UI.

The free probe defaults to the current `/inference/openai/v1` route. Use
`--upstream https://example.com/v1` to match an explicitly configured provider
endpoint. This proxy changes request conditions; a rejection is not proof that
the normal desktop request will fail.

The JSON report includes routing, model, User-Agent, client header, presence of
credentials and telemetry headers, upstream status, retry hint, and request ID.
Prompt contents, credentials, raw CLI logs, and raw provider errors are omitted.
`authorizationPresent` proves a header exists, not that it belongs to the correct
Go workspace. Live rejection classification is best-effort.

`generatedText: true` means the CLI emitted the probe's expected text. HTTP 200
alone is not enough to pass. A missing `request` event means the CLI failed before
reaching the proxy, so check that the selected model exists (`opencode models
opencode-go`) and that the chosen executable works. The default overall timeout is
60 seconds (`--timeout 120` to change it); failed upstream responses are converted
to terminal local errors to avoid long cooldowns. Later requests, including any
auxiliary title generation, are blocked rather than billed.

An offline pass establishes request construction only. Live HTTP 401/403 points
to authentication or entitlement; free-limit and Go-limit error types are
reported separately. Acceptance ultimately depends on the Go service and account;
changing the version cannot guarantee it.

Verified locally on 2026-10-29: the source CLI sent
`opencode-go/deepseek-v4.1-flash` to the Go endpoint, with a User-Agent beginning
`opencode/local`, and received HTTP 200 plus `GO_PROBE_OK` using the existing login.
This verifies the source CLI and account together, not the desktop executable.
Model availability can change; choose the exact ID from the local model list.

The earlier free probe forced the legacy `/zen/v1` endpoint and returned HTTP 429. The original desktop uses `/inference/openai/v1` with a public key and
succeeded repeatedly. An endpoint change alone did not make the proxy probe
succeed, so those proxy rejections do not establish a general account restriction.

On 2026-10-29, a direct V2 source Session completed successfully against
`opencode/nemotron-3.5-lightning-free` after fixing provider-transport inheritance
for endpoint-only model overrides and adding current OpenCode client/session
headers. It returned `GO_PROBE_OK`, 6 output tokens, and finish reason `stop`.
The validation used a fresh temporary database and the project's configured
2.2.0 desktop identity. Packaged desktop validation is recorded below.

## Confirmed desktop rejection trigger

Controlled replays on 2026-10-29 isolated the captured legacy request's failure
to the `playwright_browser_run_code_unsafe` MCP definition. The original body
returned HTTP 429 `FreeUsageLimitError`; removing only that definition returned
HTTP 200 and `GO_PROBE_OK`, preserving the endpoint, public key, headers,
messages, generation settings, and all other tools. Swapping headers did not
change the result. The provider response does not explain its internal policy.

Denying this tool through the existing `permission` configuration removes it
from the request and prevents its execution. The real legacy source CLI also
completed successfully after applying the project permission rule. This is a
targeted capability restriction, not a request to rename or conceal the tool.

The rebuilt Electron desktop had an additional transport-dependent failure:
replaying its exact post-deny payload returned HTTP 429 through Node 24 and
HTTP 200 plus `GO_PROBE_OK` through Bun. The same result reproduced outside
Electron; varying Node's automatic request headers did not reproduce the
failure in Bun. The provider's internal reason is unknown.

The desktop now launches a source-built `opencode-server` Bun executable with
its existing IPC startup/shutdown and authenticated HTTP API. The build hooks
compile it via `script/desktop-server.ts`, and packaging copies it outside the
ASAR archive. The previous Node-only sidecar is no longer the launched backend.
The backend integration test covers IPC readiness, authentication enforcement,
HTTP health, and clean shutdown.

The final macOS arm64 package was verified in the actual desktop UI using
Nemotron 3.5 Lightning Free: the main assistant response was `GO_PROBE_OK`
and the UI reported a three-second completion. The compiled backend also
loaded the project's custom tools successfully. Its compile options match the
CLI for loading package metadata and tsconfig, which runtime tool imports need.
