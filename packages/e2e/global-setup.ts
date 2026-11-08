/**
 * Global setup (F4AI-20 S14 → F4AI-31 Phase 7) — predtestová scéna sa
 * stavia len pre tie projekty, ktoré naozaj bežia:
 *
 *  - `dev`   → health check dev gateway (`http://127.0.0.1:18081/health`);
 *              UI beží na `127.0.0.1` ako container, žiadny lokálny build
 *  - `owner` → health check produkčného gateway (`https://aiforum.myhood.sk/api/health`)
 *  - `chain` → build UI (`pnpm --filter @forum4ai/ui build`, len ak `dist/`
 *              chýba) + `vite preview` na 127.0.0.1:4173 so SPA fallbackom
 *
 * `config.projects` obsahuje PO FILTER `--project`, takže single-project beh
 * nespúšťa zbytočný build ani preview. `E2E_SKIP_PREVIEW=1` vypne preview
 * aj pre `chain` (rýchly repeat nad vlastným serverom).
 *
 * `--strictPort` — ak je 4173 obsadená, zlyháme hneď namiesto tichého
 * posunu na iný port (baseURL by nesedel). Teardown ukončí preview proces.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

export const GATEWAY_URL = process.env['E2E_GATEWAY_URL'] ?? 'http://127.0.0.1:18081';
export const OWNER_API = process.env['E2E_OWNER_API'] ?? 'https://aiforum.myhood.sk/api';
export const PREVIEW_PORT = Number(process.env['E2E_PREVIEW_PORT'] ?? '4173');
export const PREVIEW_URL = `http://127.0.0.1:${String(PREVIEW_PORT)}`;

const HEALTH_TIMEOUT_MS = 30_000;

async function waitHttp(url: string, label: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<void> {
  const started = Date.now();
  let lastError = 'zatial ziadna poziadavka';
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        console.log(`[global-setup] ${label} dostupna: ${url} (${String(res.status)})`);
        return;
      }
      lastError = `HTTP ${String(res.status)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`[global-setup] ${label} nedostupna do ${String(timeoutMs)} ms: ${url} (${lastError})`);
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`[global-setup] ${cmd} ${args.join(' ')} skoncil s kodom ${String(code)}`));
    });
  });
}

const NOOP = async (): Promise<void> => {
  // bez `chain` projektu nie je čo upratovať
};

/**
 * `config.projects` Playwright **nefiltruje** podľa `--project` (overené:
 * pri `--project=owner` dostaneme dev+owner+chain), takže výber musíme
 * prečítať z argv. Bez tohto by single-project beh zbytočne staval UI a
 * spúšťal `vite preview` — a druhý concurrent beh by narazil na
 * `--strictPort` (4173 už patrí prvému behu).
 */
function selectedProjects(config: FullConfig): string[] {
  const all = config.projects.map((project) => project.name);
  const argv = process.argv.slice(2);
  const flags: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg.startsWith('--project=')) {
      flags.push(...arg.slice('--project='.length).split(','));
    } else if (arg === '--project') {
      flags.push(...(argv[index + 1] ?? '').split(','));
    }
  }
  return flags.length > 0 ? all.filter((name) => flags.includes(name)) : all;
}

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const projects = selectedProjects(config);
  const needChain = projects.includes('chain') && process.env['E2E_SKIP_PREVIEW'] !== '1';
  const needDev = projects.includes('dev') || projects.includes('chain');
  const needOwner = projects.includes('owner');
  console.log(`[global-setup] projekty: ${projects.join(', ') || '(ziadne)'} — preview: ${needChain ? 'ano' : 'nie'}`);

  // 1) live gateway — bez nich nie je E2E proti čomu hrať
  if (needDev) await waitHttp(`${GATEWAY_URL}/health`, 'dev gateway');
  if (needOwner) await waitHttp(`${OWNER_API}/health`, 'owner (VPS) gateway');

  if (!needChain) return NOOP;

  // 2) statický build UI — VŽDY nové, nie len keď `dist/` chýba.
  //    `chain` testuje build s konkrétnymi build-time env a stale `dist/`
  //    by ticho zmenil výsledok: bez `VITE_ALLOW_NSEC=true` sa tab s nsec
  //    nevykreslí a test padá na `identity-npub` (overené na 1. behu 7).
  console.log('[global-setup] staviam @forum4ai/ui pre chain (VITE_GATEWAY_URL + VITE_ALLOW_NSEC)');
  await run('pnpm', ['--filter', '@forum4ai/ui', 'build'], {
    ...process.env,
    VITE_GATEWAY_URL: GATEWAY_URL,
    VITE_ALLOW_NSEC: 'true',
  });

  // 3) vite preview — statický build na 4173, SPA fallback pre routy
  const preview: ChildProcessWithoutNullStreams = spawn(
    'pnpm',
    ['--filter', '@forum4ai/ui', 'exec', 'vite', 'preview', '--port', String(PREVIEW_PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: REPO_ROOT, stdio: 'pipe', env: process.env },
  );
  preview.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(`[vite-preview] ${chunk.toString()}`);
  });
  preview.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[vite-preview] ${chunk.toString()}`);
  });
  let stopping = false;
  preview.on('exit', (code) => {
    // SIGTERM → vite ukončí s kódom 1; to je očakávaný teardown, nie chyba
    if (!stopping && code !== 0 && code !== null) {
      console.error(`[global-setup] vite preview skonal neocekavane s kodom ${String(code)}`);
    }
  });

  try {
    await waitHttp(`${PREVIEW_URL}/`, 'vite preview');
  } catch (err) {
    preview.kill('SIGKILL');
    throw err;
  }

  return async () => {
    stopping = true;
    if (preview.exitCode === null && !preview.killed) {
      await new Promise<void>((resolve) => {
        preview.once('exit', () => resolve());
        preview.kill('SIGTERM');
        setTimeout(() => {
          if (preview.exitCode === null) preview.kill('SIGKILL');
          resolve();
        }, 3_000);
      });
    }
    console.log('[global-setup] vite preview ukonceny');
  };
}
