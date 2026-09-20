# Use your brain from anywhere over MCP

Your brain runs on your own computer. `gbrain mcp expose` publishes its MCP
server on your [Tailscale](https://tailscale.com) tailnet with HTTPS, keeps
it running as a user service, and prints the URL your other devices, apps and
cloud agents connect to. Tailscale is the recommended path; ngrok and cloud
hosts stay as [alternatives](#alternatives).

**Say to your agent:** *"use my brain over mcp"* — *"put my brain on
tailscale"* — *"connect grok bot to my brain"* / *"connect claude desktop to
my brain"* — *"reach my brain from my phone"*. The `remote-mcp` skill
(`skills/remote-mcp/SKILL.md`) walks the agent through publish, grant,
install and verify; the exact commands are below.

## Who reaches what

| Client | Shape | Why |
| --- | --- | --- |
| Your own devices — Claude Desktop, Claude Code / Codex / opencode on another laptop, phone apps on the tailnet | `tailscale serve` (tailnet-only HTTPS) — the **default** | Nothing on the public internet; Tailscale ACLs plus gbrain auth |
| Cloud agents that run in a vendor's cloud — Grok Bot, Muse, ChatGPT connector, Claude.ai / Cowork, Perplexity Computer | `tailscale funnel` (public HTTPS on the same `*.ts.net` name) — explicit `--funnel` | Their runtime is not on your tailnet; gbrain's OAuth/bearer auth plus scoped grants protect the endpoint |
| A cloud agent whose runtime you can join to your tailnet (userspace `tailscaled`, ephemeral auth key) | tailnet-only | Advanced; not automated and not verified against a real vendor runtime |

`gbrain mcp expose` never publishes to the public internet unless you pass
`--funnel`. Both shapes keep `gbrain serve --http` on its default loopback
bind (`127.0.0.1`); Tailscale terminates TLS and forwards to it. The
"`--public-url` is set but `--bind` is not" warning at startup is expected
in this shape.

## What `gbrain mcp expose` does

```bash
gbrain mcp expose                # tailnet-only, port 3131, full surface, service installed
gbrain mcp expose --funnel       # also reachable by cloud agents (public HTTPS)
gbrain mcp expose --dry-run      # print the plan, change nothing
```

Run it **on the brain host** (a thin client is refused: "run on the brain
host"). It never opens the database, so it works while `gbrain serve` holds a
PGLite brain's single-writer lock. Every step is reported as a named check
(`--json` lists them):

| Step | What happens |
| --- | --- |
| `plan` | Resolves options; detects platform, execution environment and engine kind (PGLite vs Postgres); prints what will be installed or changed. Also probes `http://127.0.0.1:<port>/health`: when something already answers there and no receipt claims that port, the run stops with `foreign_listener` ("A server already listens on 127.0.0.1:<port>. Stop it, or pass --no-service to only publish it.") **before** anything is published. `--dry-run` stops here. |
| `consent` | Installing Tailscale, running `tailscale up`, writing the serve/funnel config and creating a user service change system state. Interactive: one y/N prompt; declining is `pending` / exit 2 with "Nothing changed. Re-run with --yes to confirm." Non-interactive without `--yes`: prints the plan plus "pass --yes to confirm" and exits 2. |
| `tailscale.binary` | Finds `tailscale` on PATH or in the usual macOS/Homebrew/Linux locations. Missing: macOS installs `brew install --cask tailscale-app`; Linux runs the official `curl -fsSL https://tailscale.com/install.sh \| sh` installer (it prompts for sudo itself). `--no-install` prints the plan and exits 1 instead. Other platforms: exit 1 with https://tailscale.com/download. |
| `tailscale.login` | Reads `tailscale status --json`. Not logged in: Linux runs `sudo tailscale set --operator=$USER` first (so you can run `serve` without root afterwards; a failure is noted, not fatal) and then a flagless `sudo tailscale up`; macOS runs the app CLI's `tailscale up` (after a fresh `brew` install it opens the app and gives it a moment first). Shows the login URL. Waits up to five minutes; still not running: exit 2 with the exact re-run command. |
| `tailscale.identity` | Takes your MagicDNS name → `https://your-machine.your-tailnet.ts.net`, then pre-checks the tailnet features `serve`/`funnel` need — the Tailscale CLI does not fail when they are missing, it prints an enablement URL and waits for you interactively, so `expose` never starts it blind. `CertDomains` empty (HTTPS certificates not enabled) → `pending`, exit 2, reason `tailscale_https_not_enabled`, with https://login.tailscale.com/admin/dns and the re-run command. `--funnel` on a node without the Funnel capability → `pending`, exit 2, reason `tailscale_funnel_not_enabled`, with https://login.tailscale.com/admin/acls and the [Funnel docs](https://tailscale.com/kb/1223/funnel). In both cases nothing has been published yet. |
| `tailscale.publish` | Reads `tailscale serve status --json` — including other terminals' foreground serve sessions and a raw TCP forward on `:443` — and refuses to overwrite a `/` handler that already proxies a different local port unless `--force` (`foreign_serve_config`; a foreground session has to be stopped in its own terminal, `--force` cannot replace it). Then `tailscale serve --bg <port>` (or `tailscale funnel --bg <port>`) with a 60s timeout; a hang is reported as `unknown` with the command to run by hand. Stderr failures are classified as a second line of defense (see [Troubleshooting](#troubleshooting)). Re-reads the status to confirm the port is proxied. |
| `admin_token` | Ensures `~/.gbrain/serve/admin-token` (0600, 64 hex chars). Reused on later runs; never printed. The running server reads it as `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`, so the admin dashboard and `gbrain mcp grant --admin-token-file` work headlessly. |
| `service` | Writes the wrapper `~/.gbrain/serve/gbrain-serve.sh`, then installs a **launchd user agent** (`com.gbrain.serve`) on macOS or a **systemd user unit** (`gbrain-serve.service`) on Linux with a user bus (`daemon-reload` → `enable` → `restart`, so a re-run's regenerated wrapper takes effect) and starts it. No supervisor (cloud sandbox, ephemeral container): `service: manual` — the wrapper is written and the exact foreground and `nohup … &` commands are printed. `--no-service` only publishes an already-running server; on a re-run it keeps the service block of the existing receipt and leaves the wrapper alone. If the install fails (`service_install_failed`, exit 1) the receipt is still written with `service.state: stopped` so `--status` and `--remove` can see and clean up the published handler. |
| `verify.local` / `verify.tailnet` | `verify.local` polls `http://127.0.0.1:<port>/health` (20s wall clock; a timeout is a `warn` and exit 2 with `verify.tailnet` skipped). `verify.tailnet` polls `https://<your name>/health` (30s); `pending` is exit 2 (first certificate issuance can take a while), never a hard failure. |
| `receipt` | Writes `~/.gbrain/serve/expose.json` (0600): port, URLs, mode, surface, service target and paths, engine kind. No secrets. |

Exit codes: `0` done, `1` failed, `2` needs confirmation (`--yes`, or you
declined the prompt) or a step is still pending (a tailnet feature to enable,
Tailscale login, certificate issuance). Nothing is published before the
pre-checks pass, so an exit 2 leaves your Tailscale config as it was.

The wrapper reads the admin token from its file at run time, sources your
shell profile and `~/.gbrain/env`, prepends the Bun directory to `PATH`, and
`exec`s `gbrain serve --http --port N --public-url URL [--surface X]
[--enable-dcr]`. The token never lands in the plist, unit or wrapper.

### Success output

```
GBrain MCP server published on your tailnet
  MCP URL   https://your-machine.your-tailnet.ts.net/mcp
  Admin     https://your-machine.your-tailnet.ts.net/admin   (token: ~/.gbrain/serve/admin-token)
  Reach     tailnet only — your devices. Cloud agents (Grok Bot, Muse, ChatGPT) need `--funnel`.
  Service   launchd com.gbrain.serve, running   (log: ~/.gbrain/serve/serve.log)
  Engine    PGLite (single-writer): host-side commands that open the database fail with `live_serve` —
            administer through the running server (--admin-token-file, /admin), or move to Postgres for concurrent local use.

Next
  Grant a client   gbrain mcp grant <name> --harness <id> --profile memory-writer --source default \
                     --url https://your-machine.your-tailnet.ts.net/mcp \
                     --admin-token-file ~/.gbrain/serve/admin-token --credentials-out /private/<name>.json
  Then inside it   gbrain connect https://…/mcp --harness <id> --credentials-file /private/<name>.json --install
  Local agents     PGLite: mint before the service runs (gbrain auth create local-agents --scopes read,write),
                   then gbrain bootstrap harness --yes --port 3131 --token <value>; or grant a scoped client with
                   gbrain mcp grant … --url http://127.0.0.1:3131/mcp --admin-token-file ~/.gbrain/serve/admin-token
                   and gbrain connect http://127.0.0.1:3131/mcp --harness <id> --credentials-file … --install
  Check            gbrain mcp expose --status
```

The `Engine` and `Local agents` lines depend on the engine the receipt
recorded: a Postgres brain prints `Local agents     gbrain bootstrap harness
--yes --port 3131` because minting works while the server runs.

## Command surface

```
gbrain mcp expose [--port N] [--funnel] [--surface verbs|starter|full] [--enable-dcr]
                  [--no-tailscale] [--no-service] [--no-install] [--force]
                  [--dry-run] [--yes] [--json]
gbrain mcp expose --status [--json]
gbrain mcp expose --remove [--yes] [--json]
```

| Flag | Meaning |
| --- | --- |
| `--port N` | Local port for `gbrain serve --http` (default `3131`). Tailscale proxies `:443` on your MagicDNS name to it. |
| `--funnel` | Public HTTPS via Tailscale Funnel instead of tailnet-only Serve. Required for cloud agents. |
| `--surface verbs\|starter\|full` | Tool surface of the served MCP server (default `full`, same as `serve --http`). |
| `--enable-dcr` | Turn on self-service client registration on the served server (off by default; every self-registered connection still stops for your approval in the admin dashboard). |
| `--no-tailscale` | Skip Tailscale entirely: install the service on loopback only, publish nothing. Exclusive with `--funnel`. |
| `--no-service` | Do not create a user service; only publish a server you run yourself. |
| `--no-install` | Never install Tailscale; print the install plan and exit 1 when it is missing. |
| `--force` | Replace a `/` handler on `:443` that already proxies another local port. |
| `--dry-run` | Print the plan and stop (exit 0). Exclusive with `--status`. |
| `--yes` | Skip the consent prompt (required for non-interactive runs). |
| `--json` | One JSON document on stdout: `{ status, receipt, checks: [{name, status, detail}], next_actions, reason?, message? }`; prose goes to stderr. |

`--status` and `--remove` are exclusive with each other. Defaults: port
3131, tailnet-only, `--surface full`, DCR off, service installed whenever a
supervisor exists.

### `--status`

Reads the receipt (absent: "not exposed", exit 0 — with `--json` exit 2 so
scripts can tell), re-probes the Tailscale serve/funnel config, the service
state (`launchctl print gui/$(id -u)/com.gbrain.serve` or `systemctl --user
is-active gbrain-serve.service`) and the local and tailnet health endpoints.
Exit 0 when everything verifies, 1 otherwise.

### `--remove`

Asks for consent (or `--yes`; declining is `pending` / exit 2, nothing
changed), then stops and removes the user service (it probes the supervisor
and removes a `com.gbrain.serve` / `gbrain-serve.service` that exists even
when the receipt says the service was skipped), clears **only gbrain's own**
serve/funnel handler (the one whose proxied port
matches the receipt; Funnel is switched off first when it was on), and
deletes the wrapper and receipt. It never runs `tailscale serve reset`,
never uninstalls Tailscale and never logs you out. The admin token file is
kept unless you pass `--force` (a dashboard session may still be using it).
It prints what was left in place.

## Grant, connect, verify

The published server accepts the same clients as any `gbrain serve --http`.
Provision each client with a least-privilege grant through the running
server's authenticated admin API — the admin token file is the only
credential you need on the host, and this is the only way on a PGLite brain
while the service holds the write lock:

```bash
# On the brain host — one grant per client, private credential file
gbrain mcp grant bot-example --harness grok-bot --profile memory-writer --source default \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token \
  --credentials-out /private/bot-example.json
```

Then, inside the client's environment (after moving the credential file
there through a private channel):

```bash
gbrain connect https://your-machine.your-tailnet.ts.net/mcp --harness grok-bot \
  --credentials-file /private/bot-example.json --install --root /workspace/gbrain
gbrain mcp verify --client CLIENT_ID --harness grok-bot \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --credentials-file /private/bot-example.json --json
```

Profiles (`memory-reader`, `memory-writer`, `coding-agent`, `operator`,
`delegating-agent`, `full`), private handoff, repair and the honest
verification bar are in [hosted harness access](hosted-harness-access.md).
Per-client notes:

- **Grok Bot / Muse** — the runtime lives in the vendor cloud, so publish
  with `--funnel`. Grok Bot's root is `/workspace/gbrain`; Muse needs a
  verified durable root first. See the [Grok Bot](grok-bot.md) and
  [Muse](muse.md) guides.
- **Claude Desktop** — Settings → Integrations → add
  `https://your-machine.your-tailnet.ts.net/mcp` with a bearer token
  ([guide](../mcp/CLAUDE_DESKTOP.md)). Tailnet-only is enough on your own
  laptop.
- **Local coding agents on the host** — on a Postgres brain,
  `gbrain bootstrap harness --yes --port 3131` wires Claude Code / Codex /
  opencode to the running server. On a PGLite brain `bootstrap harness`
  refuses to mint while the service holds the database: either mint **before**
  the service runs (`gbrain auth create local-agents --scopes read,write`,
  run ahead of `gbrain mcp expose` or while the service is briefly stopped)
  and pass `gbrain bootstrap harness --yes --port 3131 --token <value>`, or
  grant a scoped client through the running server —
  `gbrain mcp grant <name> --harness <id> --profile memory-writer --source default --url http://127.0.0.1:3131/mcp --admin-token-file ~/.gbrain/serve/admin-token --credentials-out /private/<name>.json`
  then `gbrain connect http://127.0.0.1:3131/mcp --harness <id> --credentials-file /private/<name>.json --install`
  (MCP wiring only, no per-turn hooks; `http://` is accepted on loopback).
- **Coding agents on another tailnet machine** — `gbrain connect <url> --token … --install`
  with a token minted on the host ([Claude Code](../mcp/CLAUDE_CODE.md),
  [Codex](../mcp/CODEX.md)).
- **ChatGPT, Perplexity, Claude Cowork** — cloud connectors: `--funnel`, then
  the client guide ([ChatGPT](../mcp/CHATGPT.md),
  [Perplexity](../mcp/PERPLEXITY.md), [Cowork](../mcp/CLAUDE_COWORK.md)).

A passing `gbrain mcp verify` proves the server side. Native skill activation
inside Grok Bot or Muse is a separate step you observe in that product: ask
the agent to remember a randomized harmless fact, then recall it in a fresh
conversation.

## PGLite brains

PGLite is single-writer. While the service runs, host-side commands that open
the database (`gbrain doctor`, `gbrain import`, `gbrain auth create`, a second
`gbrain serve`) fail fast with `live_serve` — they do not wait. `gbrain sync`
and `gbrain sweep --once` are the exceptions: they delegate into the live
serve automatically. Administer the brain through the running server instead
(`gbrain mcp grant … --admin-token-file`, the `/admin` dashboard), or move to
Postgres for concurrent local use ([ENGINES.md](../ENGINES.md)). The success
banner says which engine the receipt recorded.

Local agents on a PGLite host: `gbrain bootstrap harness` refuses to mint
under the live serve. Mint **before** the service runs
(`gbrain auth create local-agents --scopes read,write` — run it ahead of
`gbrain mcp expose`, or stop the service briefly) and pass
`gbrain bootstrap harness --yes --port 3131 --token <value>`; or skip
bootstrap and use the scoped grant path against the loopback URL
(`gbrain mcp grant … --url http://127.0.0.1:3131/mcp --admin-token-file ~/.gbrain/serve/admin-token`
then `gbrain connect http://127.0.0.1:3131/mcp … --install`). Postgres
brains mint fine while the server runs: `gbrain bootstrap harness --yes --port 3131`.

## Troubleshooting

`gbrain mcp expose --status` re-runs the probes; `--json` names the failing
check. Logs: `~/.gbrain/serve/serve.log` and `serve.err`.

| Symptom / classified error | Fix |
| --- | --- |
| `tailscale_https_not_enabled` (exit 2, `tailscale.identity` pending) — the tailnet has no HTTPS certificates (`CertDomains` empty); nothing was published | Enable **MagicDNS** and **HTTPS Certificates** for your tailnet at https://login.tailscale.com/admin/dns, then run the printed re-run command. |
| `tailscale_funnel_not_enabled` (exit 2, `tailscale.identity` pending) — the node lacks the Funnel capability; nothing was published | Enable the `funnel` node attribute in your tailnet policy at https://login.tailscale.com/admin/acls ([Funnel docs](https://tailscale.com/kb/1223/funnel)), then re-run with `--funnel`. |
| `https_not_enabled` / `funnel_not_enabled` (exit 1) — `tailscale serve` / `funnel` itself refused after the pre-checks passed | Same fixes as the two rows above; the classifier reads the CLI's stderr as a second line of defense. `unknown` after 60s means the CLI is waiting on you — run the printed `tailscale serve --bg <port>` by hand to see its prompt. |
| `needs_operator` — "Access denied" from `tailscale serve` on Linux | `sudo tailscale set --operator=$USER`, then re-run. `expose` runs that `set --operator` itself before its flagless `sudo tailscale up` (a failure there is noted, not fatal); a tailnet joined earlier by other means may not have it. |
| `needs_login` / exit 2 after the login URL | Finish the login in the browser (macOS: open the Tailscale app and sign in), then run the printed re-run command. |
| `daemon_not_running` — "failed to connect to local Tailscale service" | macOS: `open -a Tailscale`. Linux: `sudo systemctl enable --now tailscaled`. |
| `tailnet_health: pending` (exit 2) | The first certificate for your MagicDNS name is being issued. `gbrain mcp expose --status` in a minute. Local health `ok` means the server itself is fine. |
| Another device cannot resolve `your-machine.your-tailnet.ts.net` | Resolution needs **MagicDNS** on the tailnet (https://login.tailscale.com/admin/dns) and "Use Tailscale DNS settings" turned on in that device's Tailscale client. Reaching the name over HTTPS additionally needs the tailnet's **HTTPS Certificates** toggle on the same page (the `tailscale_https_not_enabled` pre-check catches that on the host). |
| Service not starting (`--status` reports the service stopped) | Read `~/.gbrain/serve/serve.err`. Typical causes: `gbrain` not on `PATH` for a login-less shell (the wrapper falls back to `type -P gbrain`; install into `~/.bun/bin` or reinstall), a key missing from `~/.gbrain/env`, or the port already taken. `launchctl print gui/$(id -u)/com.gbrain.serve` / `systemctl --user status gbrain-serve.service` show the supervisor's view. |
| `foreign_listener` — "A server already listens on 127.0.0.1:<port>. Stop it, or pass --no-service to only publish it." | Something else answers on `127.0.0.1:<port>` and no receipt claims that port. Refused during `plan`, before anything is published. Stop it, choose another `--port`, or pass `--no-service` to only publish the server you already run. |
| `foreign_serve_config` — "tailscale serve already proxies :443 to <target>. Re-run with --force to take it over, or pick another local port for that service." | A `/` handler on `:443` (a background config, another terminal's foreground `tailscale serve` session, or a raw TCP forward) already points somewhere else. Inspect it with `tailscale serve status` (the suggested next action), move that service, or — for a background handler only — re-run with `--force`; a foreground session must be stopped in its own terminal. |
| `verify.local` warn / `local_health_timeout` (exit 2) | The service was installed but `http://127.0.0.1:<port>/health` did not answer within 20s; `verify.tailnet` is skipped. Read `~/.gbrain/serve/serve.err`, then `gbrain mcp expose --status`. |
| `service: manual` (cloud sandbox, ephemeral container, no user bus) | There is no supervisor to keep the server alive. Run the printed foreground command, or the `nohup ~/.gbrain/serve/gbrain-serve.sh &` line, and re-run `--status`. On Linux without a user bus, `loginctl enable-linger $USER` may enable one. |
| "run on the brain host" | This install is a thin client; `expose` publishes the machine that holds the database. Run it there. |
| Clients see `needsAuth` while tool calls succeed | Spec discovery, not a failed login — see [DEPLOY.md troubleshooting](../mcp/DEPLOY.md#troubleshooting). |

## Security posture

- **Tailnet-only is the default.** Only devices in your tailnet, subject to
  your Tailscale ACLs, can reach the name at all; every request still needs a
  gbrain OAuth token or bearer.
- **Funnel is public exposure.** Use it only for clients that cannot join
  your tailnet, and give each one its own least-privilege grant (a
  `memory-writer` profile scoped to one source, not `operator`). Revoke the
  client on the host when it should stop. Self-service registration stays
  off unless you pass `--enable-dcr`, and even then every new connection waits
  for your approval in the admin dashboard.
- **Loopback bind.** The server keeps `127.0.0.1`; never pass
  `--bind 0.0.0.0` for this shape. Tailscale is the only way in.
- **No secrets in chat or config.** The admin token lives in a 0600 file the
  wrapper reads at run time; the receipt carries none. Credential handoffs go
  through private files (`--credentials-out`), never pasted into a
  conversation.
- **Removal is scoped.** `--remove` touches only gbrain's own handler and
  service; your Tailscale login and other serve configs stay as they were.

See [SECURITY.md](../../SECURITY.md) for the HTTP server's hardening knobs
(CORS allowlist, trust-proxy, rate limits, body cap).

## Alternatives

**ngrok.** Public tunnel with a fixed domain on the paid tier. Run the server
yourself and point `--public-url` at the ngrok domain:

```bash
gbrain serve --http --port 3131 --public-url https://your-brain.ngrok.app
ngrok http 3131 --url your-brain.ngrok.app
```

ngrok connects to loopback on the same machine, so the default bind is right.
The [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) covers the auth
token and fixed domain; [ALTERNATIVES.md](../mcp/ALTERNATIVES.md) compares
the options.

**Cloud hosts (Fly.io, Railway, your own VM).** For a brain that must answer
while your laptop is closed, run `gbrain serve --http` on the host with a
Postgres engine and a real HTTPS front, and set `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`
through the platform's secret store ([DEPLOY.md](../mcp/DEPLOY.md)). The
grant / connect / verify hand-off above is identical; only the URL changes.

**No Tailscale, no tunnel.** `gbrain mcp expose --no-tailscale` installs the
user service on loopback only. Local agents on the same machine use
`gbrain bootstrap harness --yes --port 3131` on a Postgres brain; on PGLite,
pre-mint before the service runs and pass `--token <value>`, or use the scoped
`gbrain mcp grant … --url http://127.0.0.1:3131/mcp --admin-token-file …` +
`gbrain connect … --install` path (see [PGLite brains](#pglite-brains)).
