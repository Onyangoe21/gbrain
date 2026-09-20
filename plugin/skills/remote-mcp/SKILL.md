---
name: remote-mcp
description: |
  Publish the user's own gbrain over MCP so other devices, desktop apps and
  cloud agents can reach it. `gbrain mcp expose` installs and signs in
  Tailscale, publishes the running `gbrain serve --http` on the tailnet
  (HTTPS, tailnet-only by default; Funnel only when a client lives in a
  vendor cloud), keeps the server alive as a user service, and hands back the
  MCP URL. Then grant one least-privilege client per consumer, install the
  handoff inside that client, and verify a real memory round trip.
triggers:
  - "use my brain over mcp"
  - "serve my brain over mcp"
  - "expose my brain over mcp"
  - "gbrain mcp server"
  - "remote mcp access to my brain"
  - "put my brain on tailscale"
  - "connect grok bot to my brain"
  - "connect muse to my brain"
  - "connect claude desktop to my brain"
  - "reach my brain from my phone"
  - "gbrain mcp expose"
tools:
  - exec
mutating: true
# exempt: this skill changes host networking/service state and never answers
# a knowledge question, so there is nothing to look up in the brain first.
brain_first: exempt
---

# Remote MCP — use your brain from anywhere

> The brain already runs on the user's computer. This skill makes it reachable
> over MCP from their other devices and from the agents they use elsewhere,
> without moving the data and without putting a database on the public
> internet. Tailscale is the default transport; publishing is one command,
> access is one scoped grant per client.

## Contract

This skill guarantees:
- **Tailscale by default.** `gbrain mcp expose` publishes the local server
  with `tailscale serve` (HTTPS on the tailnet, nothing public). ngrok and
  cloud hosts stay documented alternatives, never the first suggestion.
- **Funnel is explicit.** Cloud agents whose runtime is not on the tailnet
  (Grok Bot, Muse, ChatGPT, Claude.ai / Cowork, Perplexity) need
  `--funnel`, which makes the same `*.ts.net` name publicly reachable. Say
  so before running it; the endpoint is then protected by gbrain's OAuth /
  bearer auth and scoped grants, not by the network.
- **Consent before system changes.** Installing Tailscale, running
  `tailscale up`, writing a serve/funnel config and creating a user service
  are host-state changes. Show the operator the printed plan and get a yes
  before passing `--yes`.
- **Engine-free.** `gbrain mcp expose` never opens the database. On a PGLite
  brain the running server owns the single-writer lock, so every later
  provisioning step goes through the server's authenticated admin API
  (`--admin-token-file`), never a second process on the database.
- **No secrets in chat.** The admin token lives in
  `~/.gbrain/serve/admin-token`; client credentials land in a private
  `--credentials-out` file. Quote redacted receipts only.
- **Least privilege.** One client per consumer, `memory-writer` unless the
  user explicitly asks for more. Never `operator` / `full` / `admin` to make
  a convenience check pass.
- **Server checks are not native activation.** `gbrain mcp verify` proves
  transport, auth, permissions and a write/readback. Whether the client's
  own UI actually loaded the tool is a separate observation in that client.

## Decision table — who is connecting?

| Client | Shape | Command |
| --- | --- | --- |
| Your own devices: Claude Desktop, Claude Code / Codex / opencode on another laptop, phone apps joined to the tailnet | tailnet-only HTTPS (default) | `gbrain mcp expose --yes` |
| Cloud agents running in a vendor's cloud: Grok Bot, Muse, ChatGPT connector, Claude.ai / Cowork, Perplexity Computer | public HTTPS on the same `*.ts.net` name | `gbrain mcp expose --funnel --yes` |
| Cloud agent whose runtime you can join to your tailnet (userspace `tailscaled`, ephemeral auth key) | tailnet-only | Advanced, unverified, not automated — see the [remote MCP guide](../../docs/guides/remote-mcp.md) |
| Local agents on the same machine (Claude Code, Codex, opencode) | loopback — no Tailscale needed | Postgres: `gbrain bootstrap harness --yes --port 3131`. PGLite: mint the token BEFORE the service runs (`gbrain auth create local-agents --scopes read,write` — before `gbrain mcp expose`, or while the service is briefly stopped) and pass `gbrain bootstrap harness --yes --port 3131 --token <value>`; OR use the scoped path `gbrain mcp grant <name> --harness <id> --profile memory-writer --source default --url http://127.0.0.1:3131/mcp --admin-token-file ~/.gbrain/serve/admin-token --credentials-out /private/<name>.json` then `gbrain connect http://127.0.0.1:3131/mcp --harness <id> --credentials-file /private/<name>.json --install` (MCP wiring only, no per-turn hooks) |
| Thin client only (this machine has no brain) | — | Stop: run this skill on the brain host |

Grok Bot and Muse users with no always-on machine keep the in-agent local
install described in [setup](../setup/SKILL.md) as the alternative.

## Phase 1 — Detect

```bash
gbrain engine status --json
gbrain mcp expose --status --json
```

- `thin_client: true` → the brain lives elsewhere. Stop and say the command
  runs on the brain host.
- `effective_engine: "pglite"` → note the single-writer rule (below) before
  continuing; `"postgres"` → concurrent local commands stay fine.
- `--status` reports `status: "not_exposed"` (exit 2 with `--json`) →
  Phase 2. `status: "exposed"` → skip to Phase 3 with the printed
  `mcp_url`. `status: "pending"` → the certificate or service is still coming
  up; re-run `--status` in a minute before changing anything.
- The brain is already reachable over HTTPS by other means (an existing
  `serve --http` behind ngrok / a reverse proxy, or a brain hosted elsewhere) →
  do NOT run `gbrain mcp expose`. Go straight to hosted access: grant a scoped
  client against that endpoint (Phase 3 with its URL and admin token), then
  install it in the client (Phase 4).
- Ask which clients should reach the brain (the decision table decides
  tailnet vs `--funnel`). Do not ask questions the user already answered.

## Phase 2 — Publish

Preview first, then run with consent:

```bash
gbrain mcp expose --dry-run            # prints the plan; changes nothing
gbrain mcp expose --yes                # your own devices (tailnet only)
gbrain mcp expose --funnel --yes       # a cloud agent must reach it
```

Options: `--port N` (default 3131), `--surface verbs|starter|full` (default
`full`, mirrors `serve --http`), `--enable-dcr`, `--no-tailscale` (publish
nothing; just install the service), `--no-service` (publish only; the
operator runs `serve` themselves), `--no-install` (fail instead of
installing Tailscale), `--force` (take over a serve handler that already
points at another local port), `--json`.

What the command does, in order: plan (refuses up front when a foreign
server already listens on the port and `--no-service` is absent) → consent →
find or install the `tailscale` binary → sign in if needed (Linux:
`sudo tailscale set --operator=$USER`, then `sudo tailscale up`; macOS:
`tailscale up`) → read the machine's tailnet DNS name and pre-check that
HTTPS certificates are enabled (and, with `--funnel`, that the node has the
Funnel capability) → `tailscale serve` / `funnel` → ensure the admin token →
write the wrapper and a launchd agent / systemd user unit → poll local and
tailnet `/health` → write the receipt `~/.gbrain/serve/expose.json`. With
`--json` every step is a named check (`plan`, `consent`, `tailscale.binary`,
`tailscale.login`, `tailscale.identity`, `tailscale.publish`, `admin_token`,
`service`, `verify.local`, `verify.tailnet`, `receipt`); the health checks
are `verify.local` and `verify.tailnet`, not `verify`.

Relay every prompt the command surfaces:

| Output | What you do |
| --- | --- |
| Tailscale login URL printed by `tailscale up` | Give the user the URL, wait for them to sign in; on exit 2 (`tailscale_login_pending`) re-run the exact command the output prints |
| `declined` (exit 2, "Nothing changed.") | The operator said no at the prompt. Nothing was installed or published; pass `--yes` only after they confirm the printed plan |
| `tailscale_https_not_enabled` — pre-check, exit 2, nothing published (`CertDomains` empty) | Enable MagicDNS + HTTPS Certificates at `https://login.tailscale.com/admin/dns`, then re-run the printed command. The same reason with exit 1 means the `tailscale serve` call itself refused for the same cause — same fix |
| `tailscale_funnel_not_enabled` — pre-check, exit 2, nothing published (the node lacks the Funnel capability) | Enable the `funnel` node attribute in the tailnet policy (`https://login.tailscale.com/admin/acls`; see `https://tailscale.com/kb/1223/funnel`), then re-run. Exit 1 with this reason is the post-`funnel` classified form — same fix |
| `tailscale_needs_operator` | Run `sudo tailscale set --operator=$USER`, then re-run |
| `tailscale_needs_login` | Linux: `sudo tailscale set --operator=$USER` then `sudo tailscale up`; macOS: `tailscale up` or open the Tailscale app and sign in; then re-run |
| `tailscale_daemon_not_running` (exit 2) | macOS `open -a Tailscale`; Linux `sudo systemctl enable --now tailscaled`; then re-run |
| `foreign_serve_config` — "tailscale serve already proxies :443 to …" (exit 1) | Show the user what the existing handler proxies (`tailscale serve status`); only `--force` on their explicit yes. A handler owned by another terminal's foreground `tailscale serve` session cannot be taken over — it must be stopped in that terminal |
| `foreign_listener` — "Something already answers on 127.0.0.1:<port> and no expose receipt claims it" (exit 1, refused BEFORE anything is published; ANY answer counts, a 404 too) | Stop the other process, pick another `--port`, or pass `--no-service` to publish it as-is. If it is a gbrain server left by an interrupted run, `gbrain mcp expose --remove --yes` first (receipt-less recovery) |
| `no_brain_config` (exit 1, `plan` fails) — "No brain is configured on this host (gbrain init first), so a service would only crash-loop" | Run `gbrain init` on this host first, then re-run; or pass `--no-service` to only publish a server the operator starts themselves. Never install the service around a missing brain |
| `pglite_lock` warn — "a live process holds this PGLite brain (pid N, …)" | Tell the user which process holds the lock; the service cannot start until it exits. Stop it (or route to [postgres-adopt](../postgres-adopt/SKILL.md) for concurrent use), then `gbrain mcp expose --status` |
| "could not read tailscale serve status" — `tailscale.publish` fails (publish: exit 1 `tailscale_<kind>`, nothing published; `--status`: exit 1; `--remove`: exit 1 `tailscale_serve_status_unreadable`, receipt + wrapper kept) | The command fails closed instead of guessing. Run `tailscale serve status --json`, apply the classified fix (operator / daemon / login), then re-run the same command |
| `service: manual` (no supervisor: cloud sandbox, container) | Relay the printed foreground and `nohup … &` commands; this is a documented outcome, not a failure |
| `verify.local: warn` (exit 2, `local_health_timeout`) | The service was installed but `/health` did not answer within the wait; check `~/.gbrain/serve/serve.err`, then `gbrain mcp expose --status` |
| `verify.tailnet: pending` (exit 2, `tailnet_health_pending`) | First certificate issuance can take a minute; `gbrain mcp expose --status` later |

Never work around a classified error by editing Tailscale state by hand;
apply the printed fix and re-run.

## Phase 3 — Grant one client per consumer

Run on the brain host, through the running server's admin API:

```bash
gbrain mcp grant agent-example --harness grok-bot --profile memory-writer \
  --source default \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token \
  --credentials-out /private/agent-example.json --json
```

- `--harness` is the real adapter id (`gbrain mcp adapters`): `grok-bot`,
  `muse`, `claude-desktop`, `codex`, `claude-code`, `opencode`, ...
- `--dry-run` first when the user wants to see the grant before it exists.
- Profiles (`memory-reader`, `memory-writer`, `coding-agent`, `operator`,
  `delegating-agent`, `full`) and delegation limits are defined in
  [hosted harness access](../../docs/guides/hosted-harness-access.md);
  default to `memory-writer`.
- The receipt is redacted; the credentials file is 0600. Move it to the
  client through a private channel, never through the chat.

## Phase 4 — Install inside the client

| Client | Install |
| --- | --- |
| Grok Bot | Inside the Bot: `gbrain connect https://your-machine.your-tailnet.ts.net/mcp --harness grok-bot --credentials-file /private/agent-example.json --install --root /workspace/gbrain`; enable the generated instruction as a native skill (a visible, separate step) |
| Muse | Same `gbrain connect … --harness muse … --install --root <verified durable root>`; establish the durable user-files location first — never `/tmp`, never an invented path |
| Claude Desktop | GUI: Settings → Integrations → add `https://your-machine.your-tailnet.ts.net/mcp`; supply the client id/secret from the handoff when prompted |
| Claude Code / Codex / opencode on another machine | `gbrain connect https://your-machine.your-tailnet.ts.net/mcp --harness codex --credentials-file /private/agent-example.json --install` (managed private config) |
| Local agents on the brain host | Postgres: `gbrain bootstrap harness --yes --port 3131`. PGLite: `bootstrap harness` refuses under the live serve unless `--token` is passed — mint BEFORE the service runs (`gbrain auth create local-agents --scopes read,write`, run before `gbrain mcp expose` or while the service is briefly stopped) and pass `gbrain bootstrap harness --yes --port 3131 --token <value>`; or skip hooks and use the scoped `gbrain mcp grant … --url http://127.0.0.1:3131/mcp --admin-token-file ~/.gbrain/serve/admin-token --credentials-out /private/<name>.json` + `gbrain connect http://127.0.0.1:3131/mcp --harness <id> --credentials-file /private/<name>.json --install` path (MCP wiring only) |
| ChatGPT / Perplexity / other OAuth clients | Requires `--funnel`; follow the per-client page under `docs/mcp/` with the tailnet URL |

Tailnet-only endpoints are reachable only from devices signed in to the same
tailnet — if a device cannot resolve `your-machine.your-tailnet.ts.net`,
install Tailscale there and sign in; do not switch to `--funnel` for that.

## Phase 5 — Verify

From the client's environment:

```bash
gbrain mcp verify --client CLIENT_ID --harness grok-bot \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --credentials-file /private/agent-example.json --json
```

`server_status: "passed"` proves transport, auth, permissions, read, a
randomized write/readback and cleanup. Then, in the actual client, ask it to
remember a harmless randomized fact with provenance, open a new conversation
and ask for it back, correct it, withdraw it. Exit 2 (`partial`) means that
native evidence is still missing — report it as missing, not as done.

Host-side check at any time: `gbrain mcp expose --status`. Undo everything
this skill installed: `gbrain mcp expose --remove` (stops and removes the
service — also when the receipt says it was skipped but the unit exists —
clears only gbrain's serve/funnel handler, keeps Tailscale installed and
signed in, keeps the admin token unless `--force`; without a receipt — an
interrupted publish — it recovers from what is on disk: the wrapper, the
unit and the `:443` handler for `--port`, default 3131, leaving the token).
Declining the prompt exits 2 with "Nothing changed."; a `--no-service` re-run
keeps an existing service.

## PGLite single-writer note

While the exposed server runs, it holds the PGLite lock. Host-side commands
that open the database (`gbrain doctor`, `gbrain mcp grant` WITHOUT
`--admin-token-file`, `gbrain bootstrap harness` without `--token`) FAIL FAST
with `live_serve` — they do not wait. Administer through the running server
instead. `gbrain sync` and `gbrain sweep --once` are the exceptions: they
delegate into the live serve automatically. Always provision through
`--admin-token-file`; if the user needs concurrent local commands, route to
[postgres-adopt](../postgres-adopt/SKILL.md) rather than stopping the server.

## Anti-Patterns

- NEVER recommend ngrok or a cloud host first; Tailscale is the default and
  the alternatives are for people who explicitly want them.
- NEVER `gbrain serve --http --bind 0.0.0.0` for this shape. Tailscale Serve
  terminates TLS and forwards to loopback; the default bind is correct.
- NEVER pass `--funnel` silently. Say that it makes the endpoint publicly
  reachable and why this client needs it.
- NEVER paste the admin token or a credentials file into the conversation,
  a commit, or a command argument the harness logs.
- NEVER run `tailscale serve reset`, `tailscale logout`, or uninstall
  Tailscale to clean up — `gbrain mcp expose --remove` touches only gbrain's
  handler.
- NEVER grant `operator`/`full`/`admin` because a health check failed.
- NEVER claim the client is connected because `mcp verify` passed; native
  activation and new-conversation recall are observed in the client.
- NEVER open the live PGLite database from a second process to provision.

## Output Format

Report the host state and one line per client:

```
MCP URL   https://your-machine.your-tailnet.ts.net/mcp   (reach: tailnet only | public via Funnel)
Service   launchd com.gbrain.serve, running   (log: ~/.gbrain/serve/serve.log)
Engine    pglite — provision via --admin-token-file
Client    agent-example (grok-bot, memory-writer): granted, installed, verify passed, native activation pending
Pending   <exact next command, or "nothing">
```

Quote `gbrain mcp expose --status` and `gbrain mcp verify` output as-is (both
are redacted). Name every unverified step explicitly; a passing server check
never stands in for observed recall inside the client.
