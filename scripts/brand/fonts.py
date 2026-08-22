#!/usr/bin/env python3
"""Fetch the brand typefaces and hand back usable TTF paths.

Getting a plain TTF out of the Google Fonts CSS API takes some care: a
modern User-Agent is served woff2, an ancient one is served EOT, and only
a mid-2010s Safari string yields WOFF. WOFF is zlib-wrapped sfnt, which
fontTools unpacks without brotli, so that is the route taken here. Every
converted file is opened before it is trusted, because a download that
lands is not the same as a font that works.
"""
import os
import re
import sys
import urllib.request

from fontTools.ttLib import TTFont

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_6_8) AppleWebKit/534.50 "
      "(KHTML, like Gecko) Version/5.1 Safari/534.50")

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".fonts")

FACES = {
    "Archivo-700": ("Archivo", 700),
    "Archivo-600": ("Archivo", 600),
    "Archivo-400": ("Archivo", 400),
    "JetBrainsMono-400": ("JetBrains+Mono", 400),
    "JetBrainsMono-500": ("JetBrains+Mono", 500),
    "JetBrainsMono-700": ("JetBrains+Mono", 700),
}


def _get(url, ua=UA):
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read()


def _download(family, weight, dest):
    css = _get(f"https://fonts.googleapis.com/css2?family={family}:wght@{weight}")
    m = re.search(r"url\(([^)]+)\)", css.decode("utf-8", "replace"))
    if not m:
        raise RuntimeError(f"no font url in CSS for {family} {weight}")
    raw = _get(m.group(1).strip("'\""))

    tmp = dest + ".woff"
    with open(tmp, "wb") as f:
        f.write(raw)
    font = TTFont(tmp)
    font.flavor = None
    font.save(dest)
    os.remove(tmp)
    TTFont(dest)                       # prove the result parses
    return dest


def ensure():
    os.makedirs(CACHE, exist_ok=True)
    out = {}
    for name, (family, weight) in FACES.items():
        p = os.path.join(CACHE, name + ".ttf")
        if not os.path.exists(p) or os.path.getsize(p) < 4096:
            print(f"  fetching {family} {weight}", file=sys.stderr)
            _download(family, weight, p)
        out[name] = p
    return out


if __name__ == "__main__":
    for k, v in sorted(ensure().items()):
        print(f"{k:20} {os.path.getsize(v):>8} bytes")
