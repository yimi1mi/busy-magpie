"""Create every icon the Electron app needs from magpie's own silhouette.

Outputs:
  assets/busy-magpie.ico    Windows shell / NSIS
  assets/icon.png          1024 px source for Linux and docs
  assets/icon.icns         macOS bundle icon
  assets/trayTemplate.png  16 px macOS menu-bar template
  assets/trayTemplate@2x.png
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(r"D:\Software\magpie\magpie\internal\gui\tray.png")
ASSETS = ROOT / "assets"


def rounded_tile(size: int) -> Image.Image:
    scale = 4
    s = size * scale
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    radius = int(s * 0.23)

    # A deep indigo tile with a plum breath in the lower-left.
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=radius, fill=(18, 18, 25, 255))
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-s * 0.25, s * 0.40, s * 0.85, s * 1.35), fill=(126, 105, 255, 110))
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.12))
    im.alpha_composite(glow)

    d.rounded_rectangle(
        (0, 0, s - 1, s - 1),
        radius=radius,
        outline=(255, 255, 255, 42),
        width=max(1, int(s * 0.011)),
    )
    return im.resize((size, size), Image.LANCZOS)


def load_mark() -> Image.Image:
    mark = Image.open(SOURCE).convert("RGBA")
    _, _, _, alpha = mark.split()
    tint = Image.new("RGBA", mark.size, (242, 240, 255, 0))
    tint.putalpha(alpha)
    return tint


def app_icon(size: int, mark: Image.Image) -> Image.Image:
    tile = rounded_tile(size)
    inner = round(size * 0.62)
    glyph = mark.resize((inner, inner), Image.LANCZOS)
    tile.alpha_composite(glyph, ((size - inner) // 2, (size - inner) // 2))
    return tile


def write_icns(source: Image.Image, out: Path) -> None:
    chunks: list[bytes] = []
    for kind, size in (("ic07", 128), ("ic08", 256), ("ic09", 512), ("ic10", 1024)):
        import io

        buf = io.BytesIO()
        source.resize((size, size), Image.LANCZOS).save(buf, format="PNG", optimize=True)
        data = buf.getvalue()
        chunks.append(kind.encode("ascii") + struct.pack(">I", len(data) + 8) + data)
    body = b"".join(chunks)
    out.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main() -> int:
    if not SOURCE.exists():
        print(f"missing {SOURCE}", file=sys.stderr)
        return 1
    ASSETS.mkdir(parents=True, exist_ok=True)
    mark = load_mark()

    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [app_icon(size, mark) for size in sizes]
    frames[-1].save(ASSETS / "busy-magpie.ico", format="ICO", sizes=[(s, s) for s in sizes])

    icon_1024 = app_icon(1024, mark)
    icon_1024.save(ASSETS / "icon.png", optimize=True)
    write_icns(icon_1024, ASSETS / "icon.icns")

    for name, size in (("trayTemplate.png", 16), ("trayTemplate@2x.png", 32)):
        # Menu-bar templates must be black with alpha; macOS inverts them.
        _, _, _, alpha = mark.split()
        black = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        glyph = Image.new("RGBA", mark.size, (0, 0, 0, 0))
        glyph.putalpha(alpha)
        glyph = glyph.resize((size, size), Image.LANCZOS)
        black.alpha_composite(glyph)
        black.save(ASSETS / name, optimize=True)

    print("wrote", ", ".join(p.name for p in ASSETS.iterdir() if p.suffix in {".ico", ".icns", ".png"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
