import httpx
import pytest

from tools.mcp_client_credentials import MCPClientCredentialsAuth


@pytest.mark.asyncio
async def test_mints_reuses_and_refreshes_client_credentials_token():
    calls = {"token": 0, "mcp": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            calls["token"] += 1
            return httpx.Response(
                200,
                json={"access_token": "scoped-token", "expires_in": 3600},
                request=request,
            )
        calls["mcp"] += 1
        assert request.headers["Authorization"] == "Bearer scoped-token"
        return httpx.Response(200, json={"ok": True}, request=request)

    auth = MCPClientCredentialsAuth(
        "http://gbrain/token",
        "client-id",
        "client-secret",
        "read write",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), auth=auth) as client:
        assert (await client.post("http://gbrain/mcp", json={})).status_code == 200
        assert (await client.post("http://gbrain/mcp", json={})).status_code == 200

    assert calls == {"token": 1, "mcp": 2}


def test_requires_complete_confidential_client_config():
    with pytest.raises(ValueError, match="client_credentials requires"):
        MCPClientCredentialsAuth("", "", "", "read")
