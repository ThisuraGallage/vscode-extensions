   // Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com/) All Rights Reserved.

// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at

// http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import { tool } from "ai";
import { z } from "zod";
import axios from "axios";
import * as vscode from "vscode";
import * as path from "path";
import { CopilotEventHandler } from "../../utils/events";
import { writeConfigValuesToConfig } from "../../../../utils/toml-utils";

export const TOKEN_PROXY_TOOL = "TokenProxy";

// ---------------------------------------------------------------------------
// Proxy API constants
// ---------------------------------------------------------------------------

const PROXY_BASE_URL = "http://localhost:3000";
const PROXY_CONNECTORS_PATH = "/api/connectors";
const PROXY_CONNECTIONS_PATH = "/api/connections";
const PROXY_OAUTH_INITIATE_PATH = "/api/oauth/initiate";
const PROXY_OAUTH_CREDENTIALS_PATH = "/api/oauth/credentials";

const POLL_INTERVAL_MS = 2_500;
const POLL_TIMEOUT_MS = 3 * 60 * 1_000; // 3 minutes
const PROXY_REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Vendor → Config.toml key mapping
// ---------------------------------------------------------------------------

type SupportedVendor = "gmail" | "salesforce";

const VENDOR_CONFIG_KEYS: Record<SupportedVendor, { clientId: string; clientSecret: string; refreshToken: string }> = {
    gmail: {
        clientId: "gmailClientId",
        clientSecret: "gmailClientSecret",
        refreshToken: "gmailRefreshToken",
    },
    salesforce: {
        clientId: "salesforceClientId",
        clientSecret: "salesforceClientSecret",
        refreshToken: "salesforceRefreshToken",
    },
};

// ---------------------------------------------------------------------------
// Proxy API response types
// ---------------------------------------------------------------------------

interface ConnectorInfo {
    id: string;
    name: string;
    scopes: string;
    vendor: string;
}

interface ConnectionInfo {
    connectionId: string;
    connectorId: string;
    connectorName: string;
    username: string;
}

interface OAuthInitiateResponse {
    authUrl: string;
    connectorId: string;
    connectorName: string;
}

interface CredentialsResponse {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
}

// ---------------------------------------------------------------------------
// Tool result type
// ---------------------------------------------------------------------------

export interface TokenProxyResult {
    success: boolean;
    message: string;
    vendor?: string;
    configKeys?: string[];
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const TokenProxySchema = z.object({
    vendor: z
        .enum(["gmail", "salesforce"])
        .describe("The vendor to connect. Use 'gmail' for Google Gmail and 'salesforce' for Salesforce."),
});

// ---------------------------------------------------------------------------
// Factory (mirrors createConfigCollectorTool pattern)
// ---------------------------------------------------------------------------

export function createTokenProxyTool(
    eventHandler: CopilotEventHandler,
    tempProjectPath: string,
    modifiedFiles: string[]
) {
    return tool({
        description: `
Connects an external vendor (Gmail or Salesforce) via the local Token Proxy service and writes the
resulting OAuth credentials into Config.toml automatically.

## When to use
- The user says "connect Gmail", "integrate Salesforce", "set up OAuth for Gmail/Salesforce", or similar.
- A Ballerina integration requires configurable values like gmailClientId/gmailClientSecret or
  salesforceClientId/salesforceClientSecret.
- ConfigCollector CHECK reports those keys as missing.

## How it works (do NOT describe this to the user in detail)
1. Discovers the connector from the local proxy at http://localhost:3000.
2. Initiates the OAuth flow and opens a browser window for the user to authenticate.
3. Polls until the proxy confirms the connection is established.
4. Fetches the resulting client credentials and writes them to Config.toml.

## What NOT to do
- Do NOT call this tool and also call ConfigCollector COLLECT for the same vendor keys in the same run.
- Do NOT log or display credential values in the chat.
- Do NOT call this tool if the proxy service is not running locally.
        `,
        inputSchema: TokenProxySchema,
        execute: async (input) =>
            tokenProxyExecute(input as { vendor: SupportedVendor }, tempProjectPath, modifiedFiles),
    });
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

async function tokenProxyExecute(
    input: { vendor: SupportedVendor },
    tempProjectPath: string,
    modifiedFiles: string[]
): Promise<TokenProxyResult> {
    const { vendor } = input;
    const configKeys = VENDOR_CONFIG_KEYS[vendor];

    // 1. Discover the connector id for this vendor
    let connectorId: string;
    try {
        const { data: connectors } = await axios.get<ConnectorInfo[]>(
            `${PROXY_BASE_URL}${PROXY_CONNECTORS_PATH}`,
            { timeout: PROXY_REQUEST_TIMEOUT_MS }
        );
        const match = connectors.find((c) => c.vendor === vendor || c.name.toLowerCase() === vendor);
        if (!match) {
            return {
                success: false,
                message: `Token proxy does not have a connector for vendor '${vendor}'. Available connectors: ${connectors.map((c) => c.name).join(", ")}.`,
            };
        }
        connectorId = match.id;
    } catch (err) {
        return {
            success: false,
            message: `Could not reach the local Token Proxy at ${PROXY_BASE_URL}. Make sure it is running before connecting a vendor. Details: ${(err as Error).message}`,
        };
    }

    // 2. Check if already connected — reuse existing connection
    let existingConnection: ConnectionInfo | undefined;
    try {
        const { data: connections } = await axios.get<ConnectionInfo[]>(
            `${PROXY_BASE_URL}${PROXY_CONNECTIONS_PATH}`,
            { timeout: PROXY_REQUEST_TIMEOUT_MS }
        );
        existingConnection = connections.find((c) => c.connectorId === connectorId);
    } catch {
        // Non-fatal — proceed to initiate a fresh connection
    }

    let connectionId: string;

    if (existingConnection) {
        const choice = await vscode.window.showInformationMessage(
            `Already connected to ${existingConnection.connectorName} as ${existingConnection.username}. Use this account or re-authenticate?`,
            { modal: true },
            "Use Existing",
            "Re-authenticate"
        );
        if (choice === "Use Existing") {
            connectionId = existingConnection.connectionId;
        } else {
            existingConnection = undefined;
        }
    }

    if (!existingConnection) {
        // 3. Initiate the OAuth flow
        let authUrl: string;
        try {
            const { data: initData } = await axios.get<OAuthInitiateResponse>(
                `${PROXY_BASE_URL}${PROXY_OAUTH_INITIATE_PATH}`,
                {
                    params: { connectorId },
                    timeout: PROXY_REQUEST_TIMEOUT_MS,
                }
            );
            authUrl = initData.authUrl;
        } catch (err) {
            return {
                success: false,
                message: `Failed to initiate OAuth flow for '${vendor}'. Details: ${(err as Error).message}`,
            };
        }

        // 4. Open the browser for the user to authenticate
        await vscode.env.openExternal(vscode.Uri.parse(authUrl));

        // 5. Poll until the proxy confirms the connection
        const newId = await pollForConnection(connectorId);
        if (!newId) {
            return {
                success: false,
                message: `Timed out waiting for the ${vendor} OAuth flow to complete. Please try again.`,
            };
        }
        connectionId = newId;
    }

    // 6. Fetch client credentials from the proxy
    let credentials: CredentialsResponse;
    try {
        const { data } = await axios.post<CredentialsResponse>(
            `${PROXY_BASE_URL}${PROXY_OAUTH_CREDENTIALS_PATH}`,
            { oauthConnectionId: connectionId },
            { timeout: PROXY_REQUEST_TIMEOUT_MS }
        );
        credentials = data;
    } catch (err) {
        return {
            success: false,
            message: `Connected to ${vendor} but failed to retrieve credentials. Details: ${(err as Error).message}`,
        };
    }

    // 7. Write to Config.toml (mirrors writeConfigValuesToConfig usage in config-collector)
    const configPath = path.join(tempProjectPath, "Config.toml");
    writeConfigValuesToConfig(configPath, {
        [configKeys.clientId]: credentials.clientId,
        [configKeys.clientSecret]: credentials.clientSecret,
        [configKeys.refreshToken]: credentials.refreshToken,
    });

    // Track modified file for syncing to workspace
    if (!modifiedFiles.includes("Config.toml")) {
        modifiedFiles.push("Config.toml");
    }

    return {
        success: true,
        vendor,
        configKeys: [configKeys.clientId, configKeys.clientSecret, configKeys.refreshToken],
        message: `Successfully connected ${vendor}. Credentials written to Config.toml as: ${[configKeys.clientId, configKeys.clientSecret, configKeys.refreshToken].join(", ")}.`,
    };
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

async function pollForConnection(connectorId: string): Promise<string | undefined> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        try {
            const { data: connections } = await axios.get<ConnectionInfo[]>(
                `${PROXY_BASE_URL}${PROXY_CONNECTIONS_PATH}`,
                { timeout: PROXY_REQUEST_TIMEOUT_MS }
            );
            const found = connections.find((c) => c.connectorId === connectorId);
            if (found) {
                return found.connectionId;
            }
        } catch {
            // Keep polling on transient errors
        }
    }

    return undefined;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
