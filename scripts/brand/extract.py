#!/usr/bin/env python3
"""Cut the DRZL mark out of the opaque rectangle it was flattened onto.

Both shipped logo files are the bolt sitting on a baked background: light
grey in logo.png, near-black in logo-dark.png, with only the outer margin
transparent. That slab is why the social card letterboxes and why the nav
logo sits in a faint box.

The mark itself is not touched. The background is removed by flood filling
inward from the image corners, which matters because the bolt has pale
circuit traces drawn INSIDE it: keying on luminance would punch those out,
while a fill from outside cannot reach them.
"""
import os
import sys
from collections import Counter

from PIL import Image, ImageDraw, ImageFilter

KEY = (255, 0, 255)      # flood-fill marker, absent from both sources


def background_colour(im):
    """Most common colour among opaque pixels: the slab."""
    px = im.load()
    w, h = im.size
    c = Counter()
    for y in range(0, h, 3):
        for x in range(0, w, 3):
            r, g, b, a = px[x, y]
            if a > 200:
                c[(r, g, b)] += 1
    return c.most_common(1)[0][0]


def extract(src, dst, thresh=52, feather=0.8):
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    bg = background_colour(im)

    # Flatten onto the slab colour so the transparent margin and the slab are
    # one continuous region and a single fill from the corner clears both.
    flat = Image.new("RGB", (w, h), bg)
    flat.paste(im, (0, 0), im)

    for seed in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        ImageDraw.floodfill(flat, seed, KEY, thresh=thresh)

    fp = flat.load()
    mask = Image.new("L", (w, h), 0)
    mp = mask.load()
    for y in range(h):
        for x in range(w):
            mp[x, y] = 0 if fp[x, y] == KEY else 255

    # soften the staircase the binary fill leaves on diagonals
    if feather:
        mask = mask.filter(ImageFilter.GaussianBlur(feather))

    out = im.copy()
    out.putalpha(mask)
    out = out.crop(out.getbbox())          # trim to the mark
    out.save(dst)

    kept = sum(1 for y in range(0, h, 2) for x in range(0, w, 2)
               if fp[x, y] != KEY)
    total = (h // 2) * (w // 2)
    print(f"  {os.path.basename(src):18} bg #{bg[0]:02X}{bg[1]:02X}{bg[2]:02X}"
          f"  kept {100 * kept / total:.1f}%  ->  {os.path.basename(dst)} "
          f"{out.size[0]}x{out.size[1]}")
    return out


if __name__ == "__main__":
    # The untouched originals, kept in the repository so this stays
    # idempotent: build.py overwrites docs/public/brand/logo*.png with the
    # extracted versions, so reading from there would re-extract an already
    # extracted file on the second run.
    HERE = os.path.dirname(os.path.abspath(__file__))
    REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
    SRC = os.path.join(REPO, "assets", "brand")
    OUT = os.path.join(HERE, "out")
    os.makedirs(OUT, exist_ok=True)
    extract(f"{SRC}/logo-source.png", f"{OUT}/mark-ink.png")        # dark bolt
    extract(f"{SRC}/logo-dark-source.png", f"{OUT}/mark-paper.png")  # light bolt
