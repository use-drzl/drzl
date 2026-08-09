import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Output } from './output.js';

export interface SponsorMessageOptions {
  reason?: string;
  minIntervalMs?: number;
  force?: boolean;
  /**
   * Where to write, and whether to write at all.
   *
   * This used to be `console.log`, which put an advertisement on stdout in the middle of the file
   * list a script was parsing: 246 bytes of it, measured on 4.22.0. It is narration, so it goes to
   * stderr, and `Output.wantsAsides` is what decides whether an unrequested aside has a reader:
   * not under `--quiet`, not under `--json`, and not when stderr is a pipe, because a tip written
   * into somebody's build log is only noise. The pre-existing `CI` gate below is the same idea
   * arrived at one environment at a time.
   */
  out?: Output;
}

interface SponsorCachePayload {
  runs: number;
  lastShownAt?: number;
  lastReason?: string;
}

const CACHE_DIR = path.join(process.cwd(), 'node_modules', '.cache', '@drzl');
const CACHE_FILE = path.join(CACHE_DIR, 'sponsor-message.json');
const DEFAULT_INTERVAL_MS = 1000 * 60 * 15; // 15 minutes
let shownThisProcess = false;

const tips = [
  'Pair DRZL watch mode with drizzle-kit to keep schema & API synced.',
  'Templatize your ORPC routers to roll out new endpoints safely.',
  'Need typed validators? Enable the zod, valibot, arktype, typebox, or effect generators.',
  'Need JSON Schema or OpenAPI? The json-schema generator emits both, with no runtime dependency.',
  'Use output headers to track generated files and trim noisy diffs.',
];

export function maybeShowSponsorMessage({
  reason = 'generate',
  minIntervalMs = DEFAULT_INTERVAL_MS,
  force = false,
  out = new Output(),
}: SponsorMessageOptions = {}) {
  const green = (msg: string) => out.errStyle.hex('#6ee7b7')(msg);
  const cyan = (msg: string) => out.errStyle.cyan(msg);
  const gray = (msg: string) => out.errStyle.gray(msg);

  const hideViaEnv = process.env.DRZL_HIDE_SPONSOR?.toLowerCase();
  const hideRequested = hideViaEnv === '1' || hideViaEnv === 'true';
  if (hideRequested || (process.env.CI && !force) || (shownThisProcess && !force)) return;
  if (!out.wantsAsides && !force) return;

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const payload = readCache();
    payload.runs += 1;

    const now = Date.now();
    const shouldShow = force || now - (payload.lastShownAt ?? 0) >= minIntervalMs;

    if (shouldShow) {
      payload.lastShownAt = now;
      payload.lastReason = reason;
    }

    writeCache(payload);

    if (!shouldShow) return;

    shownThisProcess = true;
    const tip = tips[payload.runs % tips.length];

    out.stderr.write(
      `\n${cyan(`🚀 DRZL finished a ${reason} run (#${payload.runs.toLocaleString()}).`)}\n\n` +
        `${green('✨ Sponsors keep DRZL shipping. Consider supporting ongoing dev:')}\n` +
        `  ${green('GitHub Sponsors')}  ${gray('→ https://github.com/sponsors/omar-dulaimi')}\n\n` +
        `${green('Pro tip:')} ${tip}\n\n`
    );
  } catch {
    // Swallow to avoid impacting generator success paths
  }
}

function readCache(): SponsorCachePayload {
  if (!existsSync(CACHE_FILE)) {
    return { runs: 0 };
  }
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as SponsorCachePayload;
    if (typeof data.runs !== 'number') return { runs: 0 };
    return data;
  } catch {
    return { runs: 0 };
  }
}

function writeCache(payload: SponsorCachePayload) {
  writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
}
