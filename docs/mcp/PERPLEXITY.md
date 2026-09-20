# Connect GBrain to Perplexity Computer

Perplexity Computer connects as a **remote** MCP client, so GBrain must be served
over HTTP and reachable at a public HTTPS URL. Perplexity does not run
`gbrain serve` (stdio) the way Claude Code does — it needs a reachable endpoint:

```
Perplexity Computer
  → ngrok tunnel (https://YOUR-DOMAIN.ngrok.app/mcp)
  → gbrain serve --http   (built-in OAuth 2.1 transport)
  → Postgres / PGLite
```

## 1. Serve GBrain over HTTP (host side)

```bash
gbrain serve --http --port 3131 --bind 0.0.0.0 \
  --public-url https://YOUR-DOMAIN.ngrok.app
```

- **`--bind 0.0.0.0` is required.** `--http` defaults to `127.0.0.1`, so
  without it the tunnel reaches the server but the connection is refused
  (`ECONNREFUSED`).
- **`--public-url` must match the tunnel.** The OAuth issuer in the discovery
  metadata has to line up with the URL Perplexity actually hits (RFC 8414 §3.3),
  or OAuth client-credentials auth fails.

Full detail on both flags (and the rest of the server setup) lives in
[DEPLOY.md — Expose the server](DEPLOY.md#3-expose-the-server).

## 2. Expose it with a tunnel

```bash
ngrok http 3131 --url YOUR-DOMAIN.ngrok.app
```

See the [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) for a persistent
tunnel.

## 3. Create credentials

Choose the authentication flow actually offered by the intended Perplexity
connection. For native OAuth/PKCE, follow
[native hosted setup](../guides/hosted-harness-access.md#native-oauth-path), using
its exact callback and authentication method. Do not assume every Perplexity
product uses the same settings.

For a connection that accepts **machine client credentials**, the authorized
administrator provisions a scoped handoff through the existing server:

```bash
gbrain mcp grant perplexity-example --harness perplexity \
  --profile memory-writer --source default \
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token \
  --credentials-out /absolute/private/perplexity-example.json --json
```

Use `--dry-run` first to review the grant. Generate instructions for that actual
registration:

```bash
gbrain mcp admin setup CLIENT_ID --harness perplexity --flow client-credentials \
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --json
```

Keep the client secret in the private handoff and enter it only in the intended
authentication settings. Ordinary setup output is redacted; explicit recovery
uses `--credentials-out PRIVATE_FILE`. Never pass the owner credential to
Perplexity. For legacy bearer connections, see [legacy setup](DEPLOY.md#legacy-bearer-token-setup).
The generic/manual adapter produces instructions; it does not claim to install
or activate Perplexity's native settings.

## 4. Add the connector in Perplexity

1. Open Perplexity (requires Pro subscription).
2. Go to **Settings → Connectors** (or **MCP Servers**).
3. Add a new remote connector:
   - **URL:** `https://YOUR-DOMAIN.ngrok.app/mcp`
   - **Authentication:** API Key / Bearer Token, or OAuth client credentials
   - Paste the token (bearer) or `client_id` + `client_secret` (OAuth).
4. Save.

## Verify

In a Perplexity conversation, ask it to use your brain:

```
Use my GBrain to search for [topic]
```

Have it call `get_brain_identity` (whose brain this is), then `list_skills`
(everything it can do).

## Notes

- Perplexity Computer is available to Pro subscribers; both the Mac app and web
  version support remote MCP connectors.
- The Mac app can also use a local MCP server (`gbrain serve` stdio) if you'd
  rather not expose an HTTP endpoint.
- A `gbrain auth create` token is a long-lived, full-access secret. Keep it
  private and prefer a scoped token where possible.
