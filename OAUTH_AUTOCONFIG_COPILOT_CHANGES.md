# OAuth Auto-Config for Copilot Flow — Change Summary

## Goal

When the LLM calls ConfigCollector before running a project that uses Gmail/Salesforce/etc., the user sees a **single popup** with all config fields grouped by OAuth vendor, each group having its own **"Auto Configure"** button. Clicking it opens their browser, they sign in, and that group's credentials auto-fill. They can also fill manually. Non-OAuth configs appear in a separate section at the bottom. Everything is submitted together with one "Save Configuration" click.

---

## 1. Shared Type Definitions (`ballerina-core/src/state-machine-types.ts`)

**What:** Added `OAuthCredentialFieldMapping` and `OAuthGroupMetadata` interfaces. Extended `ConfigurationCollectorMetadata` with an optional `oauthGroups` field (array of `OAuthGroupMetadata`).

**Why this exists:** These types are the shared contract between the extension host and the webview. When the tool decides to show an OAuth-enabled config form, it packages all vendor groups (each with a vendor name and variable-to-credential mapping) into an `oauthGroups` array inside `ConfigurationCollectorMetadata`. This metadata travels through the ApprovalManager → state machine → webview popup. The webview reads it to decide whether to render grouped sections with "Auto Configure" buttons, and which form field to fill with which credential (`credentialField: "clientId"` → fill the `gmailClientId` input with the `clientId` from the proxy response).

---

## 2. New RPC Interface Types (`ballerina-core/src/rpc-types/ai-panel/interfaces.ts`)

**What:** Added `TriggerOAuthAutoConfigRequest` (just `{ vendor: string }`) and `TriggerOAuthAutoConfigResponse` (`{ success, credentials?: { clientId, clientSecret, refreshToken }, error? }`).

**Why this exists:** When the user clicks "Auto Configure" in the webview popup, the webview needs to ask the extension host to run the OAuth flow. These types define the shape of that request and response. The request is simple — just the vendor name. The response carries the actual credential values back to the webview so it can fill the form fields. **Crucially, these credentials flow webview <-> extension only — they never reach the LLM.** The LLM only ever sees `"filled"` / `"missing"` status after the form is submitted.

---

## 3. RPC Method Declaration (`ballerina-core/src/rpc-types/ai-panel/rpc-type.ts`)

**What:** Added `triggerOAuthAutoConfig` as a `RequestType` with method string `"ai-panel/triggerOAuthAutoConfig"`.

**Why this exists:** This is the `vscode-messenger` message type declaration. Both sides (extension + webview) import this constant to ensure they're speaking the same protocol. It maps the method name string to the TypeScript request/response types.

---

## 4. API Interface (`ballerina-core/src/rpc-types/ai-panel/index.ts`)

**What:** Added `triggerOAuthAutoConfig` to the `AIPanelAPI` interface.

**Why this exists:** `AIPanelAPI` is the contract that both `AiPanelRpcManager` (extension side, implements it) and `AiPanelRpcClient` (webview side, calls it) conform to. Adding the method here ensures TypeScript enforces that both sides implement/expose it.

---

## 5. Webview RPC Client (`ballerina-rpc-client/.../ai-panel/rpc-client.ts`)

**What:** Added `triggerOAuthAutoConfig()` method that sends a request to the extension host via `this._messenger.sendRequest(...)`.

**Why this exists:** This is the webview's side of the RPC bridge. The React component calls `rpcClient.getAiPanelRpcClient().triggerOAuthAutoConfig({ vendor: "gmail" })`. This method serializes the request, sends it via `postMessage` across the iframe boundary, and returns a promise that resolves with the credentials when the extension side finishes the OAuth flow.

---

## 6. Extension-Side OAuth Handler (`ballerina-extension/.../rpc-managers/ai-panel/rpc-manager.ts`)

**What:** Added `triggerOAuthAutoConfig()` method to `AiPanelRpcManager`. It:
1. Calls `GET /api/connectors` on the proxy to discover the `connectorId` for the requested vendor
2. Builds the initiate URL with `redirect_uri=vscode://wso2.ballerina/oauth-callback`
3. Opens it in the browser via `env.openExternal()`
4. Awaits `waitForOAuthCallback()` (from `uri-handlers.ts`) which resolves when VS Code receives the `vscode://` redirect with the one-time code
5. Exchanges the code for credentials via `POST /api/oauth/token/exchange`
6. Returns the credentials to the webview

**Why this exists:** This is the actual OAuth flow execution. It runs in the extension host because only the extension host has access to `vscode.env.openExternal()` (to open the browser) and the URI handler (to receive the redirect). The webview is sandboxed and can't do either. The handler returns raw credentials to the webview — not to the LLM. The webview auto-fills its form, the user confirms, and the existing `provideConfiguration` path writes them to `Config.toml`.

---

## 7. Handler Registration (`ballerina-extension/.../rpc-managers/ai-panel/rpc-handler.ts`)

**What:** Added `messenger.onRequest(triggerOAuthAutoConfig, ...)` registration.

**Why this exists:** This is the wiring that connects incoming `"ai-panel/triggerOAuthAutoConfig"` messages from the webview to the `rpcManager.triggerOAuthAutoConfig()` method. Without this line, the message would arrive but have no handler.

---

## 8. Config Collector Tool (`config-collector.ts`)

**What:**
- Added `oauthGroups` to the Zod schema (array of `{ vendor, variables: [{ name, credentialField, description }] }`)
- Updated collect mode logic: merges OAuth group variables and regular variables into a single `allVariables` array, then calls `handleCollectMode()` **once** with all variables and the `oauthGroups` metadata attached. This opens a **single popup** containing everything.
- OAuth group variables are converted to `ConfigVariable` format (with `secret: true` by default) before merging.

**Why this exists:** This is the entry point from the LLM. When the LLM calls:
```json
{ "mode": "collect",
  "oauthGroups": [{ "vendor": "gmail", "variables": [
    { "name": "gmailClientId", "credentialField": "clientId", "description": "Gmail Client ID", "secret": true },
    { "name": "gmailClientSecret", "credentialField": "clientSecret", "description": "Gmail Client Secret", "secret": true },
    { "name": "gmailRefreshToken", "credentialField": "refreshToken", "description": "Gmail Refresh Token", "secret": true }
  ]}],
  "variables": [{ "name": "dbHost", "description": "Database host" }]
}
```
The tool combines all variables (Gmail OAuth + dbHost) and opens a **single popup**. The popup renders Gmail fields grouped under a vendor header with an "Auto Configure" button, followed by non-OAuth fields (dbHost) in a separate section at the bottom. The `credentialField` is the bridge — the LLM says "this variable maps to `clientId`" without knowing the actual value. The tool passes this mapping to the popup, the popup uses it to fill the right fields when OAuth succeeds.

---

## 9. ApprovalManager (`ApprovalManager.ts`)

**What:** `requestConfiguration()` now accepts an optional `oauthGroups` parameter (array of `OAuthGroupMetadata`) and passes it through to the popup view's `agentMetadata.configurationCollector.oauthGroups`.

**Why this exists:** The ApprovalManager is the bridge between the tool (running in the extension host during LLM execution) and the popup view (running in the webview). It opens a single popup with all metadata (variables + OAuth group info), then returns a promise that resolves when the user submits. The `oauthGroups` array in the metadata tells the popup component which variables belong to which vendor and how to render grouped sections with "Auto Configure" buttons.

---

## 10. React Component (`ConfigurationCollector/index.tsx`)

**What:**
- Added per-vendor auto-config state: `autoConfigState: Record<string, { loading: boolean; error?: string }>` — tracks loading/error independently per vendor
- Added `handleAutoConfig(vendor)` callback: calls `triggerOAuthAutoConfig` RPC for the given vendor, on success maps `credentialField` to form fields using the group's variable mappings
- Extracted `renderField()` helper to avoid duplicating field rendering logic between OAuth groups and regular variables
- In the JSX: iterates `data.oauthGroups` to render grouped sections — each vendor gets a header, "Auto Configure" button, "or enter manually" divider, and its mapped form fields. Remaining non-OAuth variables appear in a separate "Other Configuration" section at the bottom.

**Why this exists:** This is what the user actually sees. A **single popup** opens with all configuration grouped:
- For each OAuth vendor (e.g., Gmail, Salesforce):
  - Vendor header
  - "Auto Configure {vendor}" button — one click opens the browser, user signs in, that vendor's fields auto-fill
  - "or enter manually" divider
  - The vendor's form fields (e.g., gmailClientId, gmailClientSecret, gmailRefreshToken) for manual entry
- After all OAuth groups: "Other Configuration" divider + remaining non-OAuth fields (e.g., dbHost)
- Footer: Skip / Save Configuration buttons (unchanged) — everything is submitted together

The auto-config flow per vendor: click button → `handleAutoConfig(vendor)` → RPC to extension → extension runs OAuth → returns `{ clientId: "abc", clientSecret: "def", refreshToken: "ghi" }` → component finds the matching `oauthGroup`, iterates its `variables`, finds `credentialField: "clientId"` → sets `configValues["gmailClientId"] = "abc"` → form fields update. User can auto-configure multiple vendors independently, then clicks "Save Configuration" once → existing `provideConfiguration` RPC → writes all values to `Config.toml`.

---

## 11. System Prompt (`prompts.ts`)

**What:** Added a line instructing the LLM to use `oauthGroups` with `credentialField` mapping for OAuth-capable vendors.

**Why this exists:** The LLM needs to know this capability exists. Without this instruction, it would put Gmail credentials in the regular `variables` array (no auto-config button). With it, the LLM knows to use `oauthGroups` for gmail/gcalendar/salesforce and map each variable to its corresponding credential field.

---

## Data Flow Summary

```
LLM calls ConfigCollector with oauthGroups + variables
  -> config-collector.ts merges all variables into one array
    -> Single ApprovalManager.requestConfiguration(allVariables, oauthGroups metadata)
      -> Opens ONE popup with all config grouped by vendor
        -> For each OAuth vendor, user can click "Auto Configure"
          -> React calls triggerOAuthAutoConfig({ vendor }) RPC
            -> Extension: GET /api/connectors -> open browser -> waitForOAuthCallback -> POST /api/oauth/token/exchange
            -> Returns { clientId, clientSecret, refreshToken }
          -> React maps credentialField -> that vendor's form fields auto-fill
        -> User can also fill any fields manually
        -> User clicks "Save Configuration" (submits ALL values at once)
          -> provideConfiguration RPC -> ApprovalManager resolves
    -> config-collector writes ALL values to Config.toml
    -> Returns only "filled"/"missing" status to LLM (never actual values)
```
