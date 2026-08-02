import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface SponsorMessageOptions {
  reason?: string;
  minIntervalMs?: number;
  force?: boolean;
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
  'Need typed validators? Enable the zod, valibot, arktype, or typebox generators.',
  'Use output headers to track generated files and trim noisy diffs.',
];

const green = (msg: string) => chalk.hex('#6ee7b7')(msg);
const cyan = (msg: string) => chalk.cyan(msg);
const gray = (msg: string) => chalk.gray(msg);

export function maybeShowSponsorMessage({
  reason = 'generate',
  minIntervalMs = DEFAULT_INTERVAL_MS,
  force = false,
}: SponsorMessageOptions = {}) {
  const hideViaEnv = process.env.DRZL_HIDE_SPONSOR?.toLowerCase();
  const hideRequested = hideViaEnv === '1' || hideViaEnv === 'true';
  if (hideRequested || (process.env.CI && !force) || (shownThisProcess && !force)) return;

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

    console.log(
      `\n${cyan(`🚀 DRZL finished a ${reason} run (#${payload.runs.toLocaleString()}).`)}\n\n` +
        `${green('✨ Sponsors keep DRZL shipping. Consider supporting ongoing dev:')}\n` +
        `  ${green('GitHub Sponsors')}  ${gray('→ https://github.com/sponsors/omar-dulaimi')}\n\n` +
        `${green('Pro tip:')} ${tip}\n`
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
