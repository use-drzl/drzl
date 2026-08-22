#!/usr/bin/env python3
"""Build the DRZL brand image assets.

The palette is not invented here. It is lifted from
docs/.vitepress/theme/theme.css, where the "Carbon grain" system already
defines a near-black ground, a fine grain and a single lime accent, with
the contrast ratios measured in the comments. The images were the only
part of the identity not wearing it: the old banner was cyan on white in
a default sans, and the social card was the logo letterboxed on a white
field.

The mark is never redrawn. It is used exactly as shipped, only lifted off
the opaque rectangle it had been flattened onto (see extract.py).
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

import fonts

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
PUB = os.path.join(REPO, "docs", "public")
MARKS = os.path.join(HERE, "out")

F = fonts.ensure()

# ---------------------------------------------------------------- palette
# straight out of theme.css
CARBON = (0x0E, 0x0E, 0x10)
CARBON2 = (0x17, 0x17, 0x1A)
DIVIDER = (0x26, 0x26, 0x29)
LIME = (0xC7, 0xF0, 0x4A)
OLIVE = (0x4A, 0x64, 0x0D)
INK_ON_LIME = (0x0F, 0x14, 0x00)
PAPER = (0xFA, 0xFA, 0xF8)
PAPER2 = (0xF0, 0xF0, 0xEC)

ON_CARBON = (0xE8, 0xE8, 0xE6)
ON_CARBON_MUT = (0x9A, 0x9A, 0xA0)
ON_CARBON_DIM = (0x6E, 0x6E, 0x76)
ON_PAPER = (0x17, 0x17, 0x1A)
ON_PAPER_MUT = (0x55, 0x55, 0x5E)
ON_PAPER_DIM = (0x86, 0x86, 0x8E)

# The count is read off the filesystem so the banner cannot claim a number
# the repository has stopped having. build.py also writes it to a sidecar
# that a verify stage compares against, so adding a generator without
# rebuilding fails the build instead of quietly aging the image.
GENERATORS = sorted(
    d.replace("generator-", "")
    for d in os.listdir(os.path.join(REPO, "packages"))
    if d.startswith("generator-")
)
if not GENERATORS:
    raise SystemExit("found no generator packages; refusing to build a wrong banner")

WORDS = {
    20: "Twenty", 30: "Thirty", 40: "Forty", 50: "Fifty",
    60: "Sixty", 70: "Seventy", 80: "Eighty", 90: "Ninety",
}
ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight",
        "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
        "sixteen", "seventeen", "eighteen", "nineteen"]


def spell(n):
    if n < 20:
        return ONES[n].capitalize()
    tens, ones = (n // 10) * 10, n % 10
    return WORDS[tens] + ("-" + ONES[ones] if ones else "")


def font(name, size):
    return ImageFont.truetype(F[name], size)


def grain(im, light=True, alpha=6, step=3):
    """The theme's grain: two hairline patterns, not an image.

    Reproduced here so the banner sits on the same surface as the site
    rather than a flat fill that looks subtly different beside it.
    """
    g = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(g)
    c = (255, 255, 255, alpha) if light else (20, 20, 10, alpha)
    for y in range(0, im.size[1], step):
        d.line([(0, y), (im.size[0], y)], fill=c)
    c2 = (255, 255, 255, max(1, alpha - 2)) if light else (20, 20, 10, max(1, alpha - 2))
    for x in range(0, im.size[0], step):
        d.line([(x, 0), (x, im.size[1])], fill=c2)
    im.alpha_composite(g)


def mark(kind, height):
    """The shipped lockup, scaled. kind: 'ink' for light grounds, 'paper' for dark."""
    m = Image.open(os.path.join(MARKS, f"mark-{kind}.png")).convert("RGBA")
    w = round(m.width * height / m.height)
    return m.resize((w, height), Image.LANCZOS)


def bolt(kind, height):
    """Just the bolt, no wordmark: the wordmark is illegible below ~64px."""
    m = Image.open(os.path.join(MARKS, f"mark-{kind}.png")).convert("RGBA")
    m = m.crop((0, 0, m.width, 413))          # split measured from the alpha profile
    m = m.crop(m.getbbox())
    w = round(m.width * height / m.height)
    return m.resize((w, height), Image.LANCZOS)


def text(d, xy, s, f, fill, spacing=0):
    d.text(xy, s, font=f, fill=fill, spacing=spacing)


# ------------------------------------------------------------------ banner
def banner(dark=True, scale=2):
    W, H = 1280 * scale, 360 * scale
    bg = CARBON if dark else PAPER
    fg = ON_CARBON if dark else ON_PAPER
    mut = ON_CARBON_MUT if dark else ON_PAPER_MUT
    dim = ON_CARBON_DIM if dark else ON_PAPER_DIM
    accent = LIME if dark else OLIVE
    rule = DIVIDER if dark else (0xDD, 0xDD, 0xD6)

    im = Image.new("RGBA", (W, H), bg + (255,))
    grain(im, light=dark, alpha=5 if dark else 4, step=3 * scale)
    d = ImageDraw.Draw(im)

    pad = 58 * scale
    lock = mark("paper" if dark else "ink", 208 * scale)
    im.alpha_composite(lock, (pad, (H - lock.height) // 2))

    x = pad + lock.width + 68 * scale
    d.line([(x - 34 * scale, pad), (x - 34 * scale, H - pad)], fill=rule + (255,), width=scale)

    y = 84 * scale
    text(d, (x, y), "Code generation for", font("Archivo-700", 44 * scale), fg)
    y += 54 * scale
    text(d, (x, y), "Drizzle ORM", font("Archivo-700", 44 * scale), accent)
    y += 70 * scale

    sub = "Every generator. One install."
    fsub = font("Archivo-400", 20 * scale)
    text(d, (x, y), sub, fsub, mut)
    subw = d.textlength(sub, font=fsub)
    y += 38 * scale
    # the rule is measured to the line above it rather than given a round
    # number, so it stays tied to something when the copy changes
    d.line([(x, y), (x + subw, y)], fill=accent + (255,), width=2 * scale)
    y += 20 * scale
    text(d, (x, y), "A row that passes the generated schema",
         font("JetBrainsMono-400", 14 * scale), dim)
    text(d, (x, y + 22 * scale), "is a row the database accepts.",
         font("JetBrainsMono-400", 14 * scale), dim)

    # right column: the generators themselves. Printing the list is what
    # turns "twenty-seven" from a claim into something a reader can count.
    gx = 856 * scale
    gw = W - pad - gx
    d.line([(gx - 34 * scale, pad), (gx - 34 * scale, H - pad)],
           fill=rule + (255,), width=scale)
    d.text((gx, pad + 4 * scale), "G E N E R A T O R S",
           font=font("JetBrainsMono-500", 11 * scale), fill=dim)
    d.line([(gx, pad + 26 * scale), (W - pad, pad + 26 * scale)],
           fill=rule + (255,), width=scale)
    fg_m = font("JetBrainsMono-400", 12 * scale)
    cols = 3
    rows = -(-len(GENERATORS) // cols)
    colw = gw // cols
    for i, g in enumerate(GENERATORS):
        cx = gx + (i // rows) * colw
        cy = pad + 44 * scale + (i % rows) * 19 * scale
        d.text((cx, cy), g, font=fg_m, fill=mut)

    return im.convert("RGB")


# ------------------------------------------------------------- social card
def social(scale=1):
    W, H = 1280 * scale, 640 * scale
    im = Image.new("RGBA", (W, H), CARBON + (255,))
    grain(im, light=True, alpha=5, step=3 * scale)
    d = ImageDraw.Draw(im)
    pad = 84 * scale

    lock = mark("paper", 232 * scale)
    im.alpha_composite(lock, (pad, 92 * scale))

    x = pad + lock.width + 76 * scale
    d.line([(x - 38 * scale, 92 * scale), (x - 38 * scale, 324 * scale)],
           fill=DIVIDER + (255,), width=scale)

    y = 112 * scale
    text(d, (x, y), "Code generation for", font("Archivo-700", 50 * scale), ON_CARBON)
    text(d, (x, y + 60 * scale), "Drizzle ORM", font("Archivo-700", 50 * scale), LIME)
    text(d, (x, y + 142 * scale), "Every generator. One install.",
         font("Archivo-400", 23 * scale), ON_CARBON_MUT)
    text(d, (x, y + 184 * scale), "A row that passes the generated schema",
         font("JetBrainsMono-400", 16 * scale), ON_CARBON_DIM)
    text(d, (x, y + 210 * scale), "is a row the database accepts.",
         font("JetBrainsMono-400", 16 * scale), ON_CARBON_DIM)

    # the generator index: printing the list is what makes the count checkable
    d.line([(pad, 392 * scale), (W - pad, 392 * scale)], fill=DIVIDER + (255,), width=scale)
    lab = font("JetBrainsMono-500", 12 * scale)
    d.text((pad, 408 * scale), "G E N E R A T O R S", font=lab, fill=ON_CARBON_DIM)

    fm = font("JetBrainsMono-400", 14 * scale)
    cols, colw = 5, (W - pad * 2) // 5
    rows = -(-len(GENERATORS) // cols)
    for i, g in enumerate(GENERATORS):
        cx = pad + (i // rows) * colw
        cy = 442 * scale + (i % rows) * 21 * scale
        d.text((cx, cy), g, font=fm, fill=ON_CARBON_MUT)

    return im.convert("RGB")


# -------------------------------------------------------------------- run
def save(im, path, **kw):
    im.save(path, **kw)
    print(f"  {os.path.getsize(path):>8}  {os.path.relpath(path, REPO)}")


def check():
    """Compare the generator index baked into the images with the repository.

    The artwork deliberately states no count, so nothing here can become
    false. The index can still become incomplete, which this reports.
    """
    fp = os.path.join(PUB, "brand", "banner-facts.json")
    if not os.path.exists(fp):
        print("banner-facts.json missing; run build.py")
        return 1
    baked = json.load(open(fp))["names"]
    if baked == GENERATORS:
        print(f"ok: images list all {len(GENERATORS)} generators")
        return 0
    added = [g for g in GENERATORS if g not in baked]
    gone = [g for g in baked if g not in GENERATORS]
    if added:
        print(f"missing from the images: {', '.join(added)}")
    if gone:
        print(f"in the images but not the repo: {', '.join(gone)}")
    print("rebuild with: python3 build.py")
    return 1


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(check())

    os.makedirs(os.path.join(PUB, "brand"), exist_ok=True)

    save(banner(dark=True), os.path.join(PUB, "banner.png"))
    save(banner(dark=False), os.path.join(PUB, "banner-light.png"))
    save(social(), os.path.join(PUB, "social-card.png"))

    # Full lockup, transparent, for anywhere it is shown large enough to read.
    mark("ink", 512).save(os.path.join(PUB, "brand", "logo.png"))
    mark("paper", 512).save(os.path.join(PUB, "brand", "logo-dark.png"))

    # Bolt alone, for the nav. VitePress renders the logo at about 24px beside
    # the site title, so a lockup there would put the wordmark at roughly 3px,
    # immediately next to the word DRZL in live text.
    bolt("ink", 256).save(os.path.join(PUB, "brand", "mark.png"))
    bolt("paper", 256).save(os.path.join(PUB, "brand", "mark-dark.png"))
    print(f"  {'':>8}  docs/public/brand/: logo(+dark) lockup, mark(+dark) bolt")

    # PWA / touch icons: opaque, full lockup
    for size, name in ((512, "icon-512.png"), (192, "icon-192.png"),
                       (180, "apple-touch-icon.png")):
        tile = Image.new("RGBA", (size, size), CARBON + (255,))
        grain(tile, light=True, alpha=5, step=3)
        m = mark("paper", round(size * 0.68))
        tile.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
        save(tile.convert("RGB"), os.path.join(PUB, name))

    # favicons: bolt only. the wordmark is a smudge below about 64px.
    # 16/32/48 only: the VitePress head comment states exactly those three,
    # and six frames pushed the .ico past 45 KB for no one's benefit.
    ico_frames = []
    for size in (16, 32, 48):
        tile = Image.new("RGBA", (size, size), CARBON + (255,))
        b = bolt("paper", round(size * 0.74))
        tile.alpha_composite(b, ((size - b.width) // 2, (size - b.height) // 2))
        ico_frames.append(tile)
        save(tile.convert("RGB"), os.path.join(PUB, f"favicon-{size}.png"))

    ico = os.path.join(PUB, "favicon.ico")
    sizes = [(f.width, f.height) for f in ico_frames]
    ico_frames[-1].save(ico, format="ICO", sizes=sizes, append_images=ico_frames[:-1])
    with Image.open(ico) as chk:
        for s in sizes:
            chk.size = s
            chk.load()
    save(Image.open(ico), ico)

    facts = {"generators": len(GENERATORS), "names": GENERATORS}
    fp = os.path.join(PUB, "brand", "banner-facts.json")
    with open(fp, "w") as f:
        json.dump(facts, f, indent=2)
        f.write("\n")
    print(f"  {os.path.getsize(fp):>8}  {os.path.relpath(fp, REPO)}")
    print(f"\n{len(GENERATORS)} generators baked into the images")
