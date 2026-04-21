# OAuth Auto-Config Feature

## Overview
When a user selects `OAuth2RefreshTokenGrantConfig` in the connector creation form and clicks "Auto Config", the extension automates the OAuth credential setup: it runs the OAuth flow via a local proxy, creates configurable variables in `config.bal`, populates their values in `Config.toml`, and wires the variable names into the connection form fields.

## Flow
1. User clicks "Auto Config {ConnectorName}" button in the union type dropdown
2. OAuth flow initiates via local proxy at `localhost:3000` (initiate → browser login → poll for connection → fetch credentials)
3. Existing configurable variable names are fetched from the LS to avoid naming collisions
4. Four configurable variables are created with unique names (`xyzConfigClientId`, `xyzConfigClientSecret`, `xyzConfigRefreshToken`, `xyzConfigRefreshUrl`) — if names exist, bumps to `xyzConfig2*`, `xyzConfig3*`, etc.
5. Each variable is declared in `config.bal` and its credential value is populated in `Config.toml` via the language server's `updateConfigVariablesV2` API
6. The variable names (not literal values) are returned and set as the OAuth form field values, so the generated Ballerina source references configurables rather than hardcoded strings

## Key Files

| File | Role |
|---|---|
| `ballerina-extension/src/rpc-managers/common/rpc-manager.ts` | Main `oauthAutoConfig()` implementation — OAuth flow, variable creation, Config.toml population |
| `ballerina-visualizer/.../UnionType/index.tsx` | Auto Config button UI — triggers `oauthAutoConfig` RPC, maps returned variable names to form fields |
| `ballerina-core/src/rpc-types/common/interfaces.ts` | `OAuthAutoConfigRequest` / `OAuthAutoConfigResponse` type definitions |
| `ballerina-core/src/rpc-types/common/rpc-type.ts` | `common/oauthAutoConfig` RPC method registration |
| `ballerina-core/src/rpc-types/common/index.ts` | `CommonRPCAPI.oauthAutoConfig` method signature |
| `ballerina-rpc-client/src/rpc-clients/common/rpc-client.ts` | Client-side RPC call implementation |
| `ballerina-extension/src/rpc-managers/common/rpc-handler.ts` | Server-side RPC handler registration |

## Implementation Details

### oauthAutoConfig (rpc-manager.ts)
- Fetches credentials from proxy (`POST /api/oauth/credentials`)
- Gets existing config variable names via `getConfigVariablesV2` to ensure uniqueness
- Gets a FlowNode template via `getConfigVariableNodeTemplate({ isNew: true })`
- For each of the 4 variables, builds a FlowNode with `variable` (name), `type` ("string"), `defaultValue` (modified), and `configValue` (the actual credential) properties
- Calls `updateConfigVariablesV2` which returns text edits for both `config.bal` and `Config.toml`
- Applies text edits directly via `workspace.applyEdit` (bypasses `updateSourceCode` to avoid state machine transitions that would close the connection panel)
- Uses `applyBallerinaTomlEdit` for `.toml` file edits
- Ensures `config.bal` is registered with the LS via `writeBallerinaFileDidOpen` (awaited) before making update calls, and sends `packageName` in `org/name` format

### UnionType Button (UnionType/index.tsx)
- Only shown when selected union member is `OAuth2RefreshTokenGrantConfig`
- Calls `rpcClient.getCommonRpcClient().oauthAutoConfig({ connectorName })`
- Maps response variable names to OAuth form fields (`clientId`, `clientSecret`, `refreshToken`, `refreshUrl`)
- Shows "Waiting for login..." during the flow and displays errors in red
