# Brand assets

Every image DRZL ships is generated from this directory. Nothing here
redraws the mark: the bolt and the DRZL wordmark are used exactly as they
were, and the only thing done to them is lifting them off the opaque
rectangle they had been flattened onto.

## Why this exists

The palette was never the problem. `docs/.vitepress/theme/theme.css`
already defines the Carbon grain system, a near-black ground with a fine
grain and a single lime accent, with the contrast ratios measured in its
own comments. The images were the part of the identity not wearing it:

- `banner.png` was cyan on white in a default sans, sharing no colour,
  typeface or surface with the site it introduced.
- `social-card.png` was the logo file pasted into a 1280x640 frame, so
  every link preview showed a small letterboxed slab floating in white.
- Every icon carried a baked `#E7E7E7` rectangle, visible against any
  ground that was not that grey.
- `favicon-16.png` and `favicon-32.png` included the wordmark, which at
  those sizes is about four pixels tall and reads as a smudge.

## Running it

```bash
python3 scripts/brand/extract.py   # marks out of the preserved originals
python3 scripts/brand/build.py     # every shipped image
python3 scripts/brand/build.py --check
```

Needs `fonttools` and `Pillow` from pip. Typefaces are not vendored;
`fonts.py` fetches Archivo and JetBrains Mono on first run and caches them
under `.fonts/`, which is ignored. Both steps are idempotent and
reproducible: running them twice produces byte-identical files.

## What comes out

| File | Purpose |
| --- | --- |
| `banner.png` / `banner-light.png` | README header, paired in a `<picture>` |
| `social-card.png` | `og:image`, 1280x640, matching the dimensions the VitePress head declares |
| `brand/logo.png` / `logo-dark.png` | Full lockup, transparent |
| `brand/mark.png` / `mark-dark.png` | Bolt alone, for the nav |
| `icon-512` / `icon-192` / `apple-touch-icon` | Opaque, full lockup on carbon |
| `favicon-16/32/48.png`, `favicon.ico` | Bolt alone |
| `brand/banner-facts.json` | What the images claim, for `--check` |

## The originals

`assets/brand/logo-source.png` and `logo-dark-source.png` are the shipped
logo files exactly as they were before any of this, kept so the extraction
has a stable input and so the mark as originally delivered is never lost.
`extract.py` reads from there rather than from `docs/public/brand/`,
because `build.py` overwrites those, and a pipeline that read its own
output would re-extract an already-extracted file on the second run.

## Why the artwork states no count

The README says twenty-seven generators, and that number is prose someone
maintains. Baking it into a PNG would put a claim somewhere no gate can
read, which is the failure mode `scripts/verify/stages/35-docs-numbers.sh`
exists to prevent. So the banner says "Every generator. One install." and
prints the generator names instead, a list rather than an assertion.

The list can still fall behind. `build.py --check` compares the names in
`banner-facts.json` against `packages/generator-*` and exits non-zero when
they diverge, naming what is missing. It is not wired into
`verify-packed.sh`, whose stage list is an explicit array in
`scripts/verify-packed.sh`; adding it there is a one-line change if you
want the gate to enforce it.
