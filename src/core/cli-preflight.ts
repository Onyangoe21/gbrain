/**
 * CLI startup preflight — the FIRST statement of `cli.ts:main()`, before
 * global-flag parsing and any command dispatch. Three ordered steps:
 *
 *   1. `quarantineCwdDotenv()` — drop the security-relevant GBRAIN_* keys that
 *      a `.env` in the cwd assigns (see env-trust.ts). GBRAIN_HOME is on that
 *      list, so it is quarantined BEFORE step 2 resolves the config dir.
 *   2. `loadGbrainEnvFile(configDir)` — fill process.env from `~/.gbrain/.env`
 *      (never overriding an exported variable). `loadConfig()` does this too,
 *      but the guardrails loader in step 3 runs before any `loadConfig()`;
 *      without this step `~/.gbrain/.env` could not be the operator's home
 *      for GBRAIN_GUARDRAILS_MODULE.
 *   3. The #3688 guardrails loader (moved verbatim from cli.ts). Fail-closed:
 *      set-but-broken aborts rather than silently running without the
 *      operator's firewall; unset costs nothing.
 *
 * Every runtime entry — commands, `hook *`, `serve` (stdio and --http),
 * `mcp`, the supervisor-spawned `jobs work` — dispatches through `main()`,
 * so this one call covers every gbrain process. (`src/commands/auth.ts`'s
 * `import.meta.main` seam is a dev-only direct-script entry.)
 */
import { quarantineCwdDotenv } from './env-trust.ts';
import { loadGbrainEnvFile } from './gbrain-env-file.ts';
import { configDir } from './config.ts';

export async function runCliPreflight(): Promise<void> {
  quarantineCwdDotenv();
  loadGbrainEnvFile(configDir);
  if (process.env.GBRAIN_GUARDRAILS_MODULE) {
    try {
      const { loadGuardrailProvidersFromEnv } = await import('./guardrails.ts');
      await loadGuardrailProvidersFromEnv();
    } catch (err) {
      console.error(`guardrails: ${(err as Error)?.message ?? String(err)}`);
      process.exit(1);
    }
  }
}
