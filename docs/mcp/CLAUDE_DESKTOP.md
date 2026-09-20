# Connect GBrain to Claude Desktop

This page covers connecting Claude Desktop to a **remote** brain. For a brain
on the same machine as Claude Desktop, a local stdio entry in
`claude_desktop_config.json` with `"command": "gbrain", "args": ["serve"]`
works too — but only against a full local install, never a thin-client one.

For remote setup, first select [native OAuth/PKCE or a private machine
handoff](../guides/hosted-harness-access.md) according to the connection settings
available in your installed Claude product. To open the owner dashboard or
manage its clients, use [MCP administration](ADMIN.md); the harness's OAuth
scope does not grant that authority.

**Important:** Claude Desktop does NOT connect to remote MCP servers via
`claude_desktop_config.json`. That file only works for local stdio servers.
Remote HTTP servers must be added through the GUI.

## Setup

1. Open Claude Desktop
2. Go to **Settings > Integrations**
3. Click **Add Integration** (or **Add Connector**)
4. Enter the MCP server URL:
   ```
   https://YOUR-DOMAIN.ngrok.app/mcp
   ```
   Replace `YOUR-DOMAIN` with your ngrok domain (see
   [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) for setup).
5. Choose the authentication method that the settings support. For native OAuth,
   use the owner-issued client metadata and the [native connection
   procedure](../guides/hosted-harness-access.md#native-oauth-path). For an
   existing bearer connection, enter its private scoped token. Never enter the
   server's owner bootstrap credential as the MCP credential.
6. Save

## Verify

Start a new conversation and try:

```
Search my brain for [any topic]
```

Observe the actual GBrain tool call and result. A saved configuration alone does
not establish that this Claude Desktop session loaded or connected the server.

## Common Mistakes

**Using claude_desktop_config.json for remote servers** — this silently fails
with no error message. The JSON config only works for local stdio MCP servers.
Remote HTTP servers must be added via Settings > Integrations in the GUI.

**Using the wrong URL** — make sure the URL ends with `/mcp` (not `/health`
or just the base domain).
