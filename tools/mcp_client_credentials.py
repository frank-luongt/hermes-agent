"""Headless OAuth client-credentials auth for HTTP MCP servers.

The MCP SDK OAuth provider is authorization-code/PKCE oriented. Long-running
container agents need a distinct confidential client that can refresh without a
browser. This httpx.Auth implementation keeps the access token in memory,
refreshes before expiry, and retries once on 401.
"""

from __future__ import annotations

import time
from typing import AsyncGenerator

import httpx


class MCPClientCredentialsAuth(httpx.Auth):
    requires_response_body = True

    def __init__(
        self,
        token_url: str,
        client_id: str,
        client_secret: str,
        scope: str,
    ) -> None:
        if not token_url or not client_id or not client_secret:
            raise ValueError("client_credentials requires token_url, client_id, and client_secret")
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._scope = scope
        self._access_token: str | None = None
        self._expires_at = 0.0

    def _token_request(self) -> httpx.Request:
        return httpx.Request(
            "POST",
            self._token_url,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "client_credentials",
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "scope": self._scope,
            },
        )

    async def async_auth_flow(
        self,
        request: httpx.Request,
    ) -> AsyncGenerator[httpx.Request, httpx.Response]:
        if self._access_token is None or time.time() >= self._expires_at - 60:
            token_response = yield self._token_request()
            try:
                await token_response.aread()
                token_response.raise_for_status()
                payload = token_response.json()
                token = payload.get("access_token")
                if not isinstance(token, str) or not token:
                    raise httpx.HTTPError("OAuth token response omitted access_token")
                ttl = max(60, int(payload.get("expires_in", 3600)))
                self._access_token = token
                self._expires_at = time.time() + ttl
            except Exception:
                self._access_token = None
                self._expires_at = 0.0
                raise

        request.headers["Authorization"] = "Bearer " + str(self._access_token)
        response = yield request
        if response.status_code != 401:
            return

        self._access_token = None
        self._expires_at = 0.0
        token_request = self._token_request()
        token_response = yield token_request
        await token_response.aread()
        token_response.raise_for_status()
        payload = token_response.json()
        token = payload.get("access_token")
        if not isinstance(token, str) or not token:
            raise httpx.HTTPError("OAuth token response omitted access_token")
        self._access_token = token
        self._expires_at = time.time() + max(60, int(payload.get("expires_in", 3600)))
        retry = httpx.Request(
            request.method,
            request.url,
            headers=request.headers,
            content=request.content,
        )
        retry.headers["Authorization"] = "Bearer " + self._access_token
        yield retry
