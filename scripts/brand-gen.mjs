#!/usr/bin/env node
// Generate DRZL brand assets from a source image using sharp.
// Usage: node scripts/brand-gen.mjs assets/brand/source.jpg

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const input = args[0] || 'assets/brand/source.jpg';
const getArg = (k, def) => {
  const m = args.find((a) => a.startsWith(`--${k}=`));
  if (!m) return def;
  const v = m.split('=')[1];
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};
const mode = getArg('mode', 'icon'); // 'icon' or 'lockup'
const topPct = getArg('top', 0.15); // 15% top offset default
const heightPct = getArg('height', 0.7); // 70% default
const bgArg = getArg('bg', null); // optional hex like #e8e6e7
const bannerTitle = getArg('bannerTitle', 'DRZL');
const bannerSubtitle = getArg('bannerSubtitle', 'Zero‑friction codegen for Drizzle ORM');
const bannerOut = getArg('bannerOut', 'docs/public/banner.png');
const outBrand = 'docs/public/brand';
const outPublic = 'docs/public';

await fs.mkdir(outBrand, { recursive: true });
await fs.mkdir(outPublic, { recursive: true });

async function save(pipeline, file) {
  const out = path.join(outPublic, file);
  await pipeline.toFile(out);
  return out;
}

async function saveBrand(pipeline, file) {
  const out = path.join(outBrand, file);
  await pipeline.toFile(out);
  return out;
}

async function main() {
  try {
    const src = sharp(input);
    // Use source dims; optional trim caused issues on some libvips builds
    const meta = await src.metadata();
    const w = meta.width ?? 1024;
    const h = meta.height ?? 1024;

    // Create a mark by cropping a centered band (keeps full symbol, avoids bottom wordmark)
    let region;
    if (mode === 'lockup') {
      region = { left: 0, top: 0, width: w, height: h };
    } else {
      const cropH = Math.round(h * heightPct); // portion of height
      const top = Math.max(0, Math.round(h * topPct));
      region = { left: 0, top, width: w, height: Math.min(cropH, h - top) };
    }
    const mark = sharp(input).extract(region);

    // Fit the mark into a square canvas with transparent background, max dimension 1024
    const markSquare = mark
      .png()
      .resize({
        width: 1024,
        height: 1024,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });

    // Base logo (for light theme)
    const baseBuf = await markSquare.clone().png().toBuffer();
    await sharp(baseBuf).toFile(path.join(outBrand, 'logo.png'));
    // Dark-theme logo: invert colors while keeping alpha
    await sharp(baseBuf).negate({ alpha: false }).toFile(path.join(outBrand, 'logo-dark.png'));

    // Favicons / app icons
    await save(markSquare.clone().resize(512, 512), 'icon-512.png');
    await save(markSquare.clone().resize(192, 192), 'icon-192.png');
    await save(markSquare.clone().resize(180, 180), 'apple-touch-icon.png');
    await save(markSquare.clone().resize(48, 48), 'favicon-48.png');
    await save(markSquare.clone().resize(32, 32), 'favicon-32.png');
    await save(markSquare.clone().resize(16, 16), 'favicon-16.png');
    try {
      await save(markSquare.clone().resize(32, 32).toFormat('ico'), 'favicon.ico');
    } catch (_) {
      // If ICO unsupported, skip; PNG favicon links will cover most cases
    }

    // Social card 1280x640 (centered mark)
    // Background color for social card
    let bg = null;
    if (bgArg) {
      const normalized = String(bgArg).startsWith('#') ? String(bgArg) : `#${bgArg}`;
      bg = normalized;
    } else {
      // Sample from source image (fallback)
      const sample = {
        left: Math.round(w * 0.05),
        top: Math.round(h * 0.05),
        width: Math.max(4, Math.round(w * 0.2)),
        height: Math.max(4, Math.round(h * 0.2)),
      };
      const stats = await sharp(input).extract(sample).stats();
      const toHex = (n) =>
        Math.max(0, Math.min(255, Math.round(n)))
          .toString(16)
          .padStart(2, '0');
      bg = `#${toHex(stats.channels[0].mean)}${toHex(stats.channels[1].mean)}${toHex(stats.channels[2].mean)}`;
    }
    const social = sharp({ create: { width: 1800, height: 480, channels: 4, background: bg } });
    const markForSocial = await markSquare.clone().resize(420, 420).toBuffer();
    await social
      .composite([{ input: markForSocial, gravity: 'center' }])
      .png()
      .toFile(path.join(outPublic, 'social-card.png'));

    // Hero banner with gradient sky + globe grid and headline
    const bannerW = 1800,
      bannerH = 480;
    const cx = bannerW / 2,
      cy = bannerH + 220;
    const rings = Array.from({ length: 8 }, (_, i) => {
      const rx = 600 + i * 160;
      const ry = 180 + i * 60;
      return `<ellipse cx=\"${cx}\" cy=\"${cy}\" rx=\"${rx}\" ry=\"${ry}\" fill=\"none\" stroke=\"#cbd5e1\" stroke-opacity=\"0.35\" stroke-width=\"1\"/>`;
    }).join('\n');
    const meridians = [-30, -18, 0, 18, 30]
      .map((deg) => {
        return `<ellipse cx=\"${cx}\" cy=\"${cy}\" rx=\"900\" ry=\"240\" fill=\"none\" stroke=\"#cbd5e1\" stroke-opacity=\"0.25\" stroke-width=\"1\" transform=\"rotate(${deg} ${cx} ${cy})\"/>`;
      })
      .join('\n');
    const svg = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<svg width=\"${bannerW}\" height=\"${bannerH}\" viewBox=\"0 0 ${bannerW} ${bannerH}\" xmlns=\"http://www.w3.org/2000/svg\">\n  <defs>\n    <linearGradient id=\"bg\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n      <stop offset=\"0%\" stop-color=\"#f1f5f9\"/>\n      <stop offset=\"100%\" stop-color=\"${bg}\"/>\n    </linearGradient>\n    <radialGradient id=\"glow\" cx=\"50%\" cy=\"40%\" r=\"70%\">\n      <stop offset=\"0%\" stop-color=\"#ffffff\" stop-opacity=\"0.6\"/>\n      <stop offset=\"100%\" stop-color=\"#ffffff\" stop-opacity=\"0\"/>\n    </radialGradient>\n    <style>\n      @font-face { font-family: system-ui; src: local('Inter'), local('Segoe UI'), local('Roboto'), local('Helvetica Neue'), local('Arial'); }\n      .kicker { font: 700 28px/1 system-ui, Inter, Segoe UI, Roboto, Arial, sans-serif; letter-spacing: 6px; fill: #64748b; }\n      .headline { font: 900 92px/1.08 system-ui, Inter, Segoe UI, Roboto, Arial, sans-serif; fill: #0f172a; }\n      .accent1 { fill: #06B6D4; }\n      .accent2 { fill: #2F74C0; }\n      .sub { font: 500 36px/1.4 system-ui, Inter, Segoe UI, Roboto, Arial, sans-serif; fill: #334155; }\n    </style>\n  </defs>\n  <rect width=\"100%\" height=\"100%\" fill=\"url(#bg)\"/>\n  <rect width=\"100%\" height=\"100%\" fill=\"url(#glow)\" opacity=\"0.5\"/>\n  <g opacity=\"0.9\">\n    ${rings}\n    ${meridians}\n  </g>\n  <g transform=\"translate(110,110)\">\n    <text class=\"kicker\">GET STARTED WITH DRZL</text>\n  </g>\n  <g transform=\"translate(110,220)\">\n    <text class=\"headline\">Next‑gen codegen for <tspan class=\"accent1\">Drizzle ORM</tspan></text>\n  </g>\n  <g transform=\"translate(110,310)\">\n    <text class=\"sub\">Analyze schemas. Generate <tspan class=\"accent2\">services, routers</tspan> &amp; validation.</text>\n  </g>\n</svg>`;
    await sharp(Buffer.from(svg)).png().toFile(bannerOut);

    console.log('Brand assets generated in docs/public and docs/public/brand');
  } catch (err) {
    console.error('Brand generation failed:', err?.message || err);
    process.exit(1);
  }
}

await main();
