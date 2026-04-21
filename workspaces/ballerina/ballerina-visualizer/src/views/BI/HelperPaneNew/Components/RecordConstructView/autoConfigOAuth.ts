/**
 * Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/* TODO: Revisit this webview-side OAuth flow implementation.
 * Currently unused — the RPC path (oauthAutoConfig via rpc-manager) is used instead.

const PROXY_BASE_URL = "http://localhost:3000";
const CONNECTOR_ID = "88916F5A-D321-469B-AD58-E779D7E0A606";
const REFRESH_URL = "http://localhost:3000/api/oauth/token";

const POLL_INTERVAL_MS = 2_500;
const POLL_TIMEOUT_MS = 3 * 60 * 1_000;

interface ConnectionInfo {
    connectionId: string;
    connectorId: string;
}

interface CredentialsResponse {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
}

export interface AutoConfigCredentials {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    refreshUrl: string;
}

export async function autoConfigOAuth(
    openExternalUrl: (url: string) => void
): Promise<AutoConfigCredentials> {
    // 1. Initiate OAuth flow
    const initiateRes = await fetch(
        `${PROXY_BASE_URL}/api/oauth/initiate?connectorId=${CONNECTOR_ID}`
    );
    if (!initiateRes.ok) {
        throw new Error(`Failed to initiate OAuth flow: ${initiateRes.statusText}`);
    }
    const { authUrl } = await initiateRes.json();

    // 2. Open browser for user to authenticate
    openExternalUrl(authUrl);

    // 3. Poll until the proxy confirms the connection
    const connectionId = await pollForConnection();
    if (!connectionId) {
        throw new Error("Timed out waiting for OAuth flow to complete. Please try again.");
    }

    // 4. Fetch credentials
    const credRes = await fetch(`${PROXY_BASE_URL}/api/oauth/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oauthConnectionId: connectionId }),
    });
    if (!credRes.ok) {
        throw new Error(`Failed to retrieve credentials: ${credRes.statusText}`);
    }
    const credentials: CredentialsResponse = await credRes.json();

    return {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        refreshToken: credentials.refreshToken,
        refreshUrl: REFRESH_URL,
    };
}

async function pollForConnection(): Promise<string | undefined> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        try {
            const res = await fetch(`${PROXY_BASE_URL}/api/connections`);
            const connections: ConnectionInfo[] = await res.json();
            const found = connections.find((c) => c.connectorId === CONNECTOR_ID);
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

*/
