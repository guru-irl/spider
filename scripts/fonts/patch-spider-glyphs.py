#!/usr/bin/env python3
"""Patch named CaskaydiaCove Nerd Font files; keep each first .spider-original."""

import argparse
from copy import deepcopy
import itertools
import math
import os
from pathlib import Path
import stat
import sys
import tempfile

from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, TTLibError

WEB = 0xF0BCA
ROBOT = 0xF167A
ROBOT_FRAMES = range(0xF2120, 0xF2124)
FAMILY = "CaskaydiaCove Nerd Font"
SPOKES = [((28, 3), (28, 53)), ((3, 28), (53, 28)),
          ((10.32, 10.32), (45.68, 45.68)), ((45.68, 10.32), (10.32, 45.68))]


def arc(center, radius, start, end, steps):
    cx, cy = center
    angles = (start + (end - start) * i / steps for i in range(steps + 1))
    return [(cx + radius * math.cos(a), cy + radius * math.sin(a)) for a in angles]


def capsule(p, q, half_stroke):
    angle = math.atan2(q[1] - p[1], q[0] - p[0])
    return (arc(q, half_stroke, angle - math.pi / 2, angle + math.pi / 2, 8)
            + arc(p, half_stroke, angle + math.pi / 2, angle + 3 * math.pi / 2, 8))


def ring(radius, half_stroke):
    step = math.pi / 4
    outer, inner = [], []
    # Offset a regular octagon's edges by half the stroke. Round the outer joins.
    inner_radius = radius - half_stroke / math.cos(step / 2)
    for i in range(8):
        angle = -math.pi / 2 + i * step
        vertex = (28 + radius * math.cos(angle), 28 + radius * math.sin(angle))
        outer += arc(vertex, half_stroke, angle - step / 2, angle + step / 2, 4)
        inner.append((28 + inner_radius * math.cos(angle), 28 + inner_radius * math.sin(angle)))
    return outer, inner


def web_glyph(source):
    # Fit the 2.5-unit stroke drawing in the original glyph's bounding box.
    # Integer center and an even side make the result reproducible on reruns.
    if not source.numberOfContours:
        raise ValueError("U+F0BCA has no outline")
    half_side = min(source.xMax - source.xMin, source.yMax - source.yMin) // 2
    if half_side <= 0:
        raise ValueError("U+F0BCA has no usable bounds")
    cx = (source.xMin + source.xMax) // 2
    cy = (source.yMin + source.yMax) // 2
    half_stroke = 1.25
    scale = half_side / (25 + half_stroke)
    shapes = [(capsule(p, q, half_stroke), True) for p, q in SPOKES]
    for radius in (9, 17, 25):
        outer, inner = ring(radius, half_stroke)
        shapes.extend([(outer, True), (inner, False)])
    pen = TTGlyphPen(None)
    for outline, solid in shapes:
        points = [(round(cx + (x - 28) * scale), round(cy - (y - 28) * scale)) for x, y in outline]
        points = [p for i, p in enumerate(points) if p != points[i - 1]]
        if len(points) < 3:
            raise ValueError("U+F0BCA is too small for the web outline")
        area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]))
        # TrueType fills clockwise contours and cuts out counterclockwise ones.
        if (solid and area > 0) or (not solid and area < 0):
            points.reverse()
        pen.moveTo(points[0])
        for p in points[1:]:
            pen.lineTo(p)
        pen.closePath()
    return pen.glyph()


def robot_glyphs(source, units_per_em):
    if source.numberOfContours != 4:
        raise ValueError("U+F167A does not have the expected robot outline")
    contours = [range(start, end) for start, end in itertools.pairwise([0, *(n + 1 for n in source.endPtsOfContours)])]
    eyes = sorted(contours, key=len)[:2]
    if len(eyes[0]) != len(eyes[1]) or sum(len(c) for c in eyes) >= len(source.coordinates) / 2:
        raise ValueError("cannot identify the robot's eyes at U+F167A")
    distance = round(130 * units_per_em / 2048)
    for dx, squash in ((0, 1), (-distance, 1), (distance, 1), (0, 0.16)):
        frame = deepcopy(source)
        for eye in eyes:
            y = [source.coordinates[i][1] for i in eye]
            middle = (min(y) + max(y)) / 2
            for i in eye:
                x, y = source.coordinates[i]
                frame.coordinates[i] = (x + dx, round(middle + (y - middle) * squash))
        yield frame


def supplementary_cmaps(font):
    return [t.cmap for t in font["cmap"].tables if t.isUnicode() and t.format in (12, 13)]


def matches(font, name, glyph, metric):
    glyf = font["glyf"]
    return name in glyf and font["hmtx"][name] == metric and glyf[name].getCoordinates(glyf) == glyph.getCoordinates(glyf)


def expected_patch(font):
    if "glyf" not in font or "fvar" in font or not (font["name"].getBestFamilyName() or "").startswith(FAMILY):
        raise ValueError(f"expected a static {FAMILY} TrueType font")
    cmap = font.getBestCmap() or {}
    if WEB not in cmap or ROBOT not in cmap or not supplementary_cmaps(font):
        raise ValueError("font lacks the source web or robot in a supplementary Unicode cmap")
    glyf = font["glyf"]
    web_name, robot_name = cmap[WEB], cmap[ROBOT]
    for table in font["cmap"].tables:
        if table.isUnicode() and any(name == web_name and cp != WEB for cp, name in table.cmap.items()):
            raise ValueError("U+F0BCA shares its glyph with another Unicode character")
    web = web_glyph(glyf[web_name])
    web.recalcBounds(glyf)
    patch = {WEB: (web_name, web, (font["hmtx"][web_name][0], web.xMin))}
    for index, (cp, frame) in enumerate(zip(ROBOT_FRAMES, robot_glyphs(glyf[robot_name], font["head"].unitsPerEm))):
        frame.recalcBounds(glyf)
        patch[cp] = (f"spider.bot{index}", frame, (font["hmtx"][robot_name][0], frame.xMin))
    return patch


def is_patched(font, patch):
    cmaps = supplementary_cmaps(font)
    occupied = [cp for cp in ROBOT_FRAMES if any(cp in cmap for cmap in cmaps)]
    if not occupied:
        return False
    for cp in occupied:
        _, glyph, metric = patch[cp]
        names = {cmap.get(cp) for cmap in cmaps}
        if len(names) != 1 or None in names or not matches(font, next(iter(names)), glyph, metric):
            raise ValueError(f"U+{cp:05X} is already occupied by a different glyph")
    name, glyph, metric = patch[WEB]
    if len(occupied) != len(ROBOT_FRAMES) or not matches(font, name, glyph, metric):
        raise ValueError("found an incomplete Spider glyph patch")
    return True


def apply_patch(font, patch):
    order = font.getGlyphOrder()
    names = [patch[cp][0] for cp in ROBOT_FRAMES]
    if set(names) & set(order):
        raise ValueError("a Spider glyph name is already in use")
    font.setGlyphOrder(order + names)
    cmaps = supplementary_cmaps(font)
    maxp = font["maxp"]
    for cp, (name, glyph, metric) in patch.items():
        font["glyf"][name] = glyph
        font["hmtx"][name] = metric
        maxp.maxPoints = max(maxp.maxPoints, len(glyph.coordinates))
        maxp.maxContours = max(maxp.maxContours, glyph.numberOfContours)
        if cp != WEB:
            for cmap in cmaps:
                cmap[cp] = name
            if "vmtx" in font:
                font["vmtx"][name] = font["vmtx"][font.getBestCmap()[ROBOT]]


def patch_file(path):
    original = path.lstat()
    if not stat.S_ISREG(original.st_mode) or path.suffix.lower() != ".ttf":
        raise ValueError("expected a regular .ttf file, not a symlink")
    backup = path.with_suffix(path.suffix + ".spider-original")
    with tempfile.TemporaryDirectory(dir=path.parent, prefix=".spider-glyphs-") as temp_dir:
        staged = Path(temp_dir) / "font.ttf"
        with TTFont(path, lazy=True, recalcBBoxes=False, recalcTimestamp=False) as font:
            patch = expected_patch(font)
            if is_patched(font, patch):
                return "already patched"
            apply_patch(font, patch)
            font.save(staged)
        with TTFont(staged) as saved:
            # Reopen the result and verify the actual emitted outlines and cmap.
            if not is_patched(saved, expected_patch(saved)):
                raise ValueError("staged patch is missing its robot frames")
        current = path.lstat()
        if (current.st_dev, current.st_ino, current.st_mtime_ns, current.st_size) != (
                original.st_dev, original.st_ino, original.st_mtime_ns, original.st_size):
            raise ValueError("font changed while being patched")
        staged.chmod(stat.S_IMODE(original.st_mode))
        try:
            os.link(path, backup, follow_symlinks=False)
        except FileExistsError:
            if not stat.S_ISREG(backup.lstat().st_mode):
                raise ValueError(f"backup is not a regular file: {backup}") from None
        os.replace(staged, path)
    return f"patched (backup: {backup})"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fonts", metavar="FONT.ttf", type=Path, nargs="+")
    args = parser.parse_args()
    for path in args.fonts:
        path = path.expanduser()
        try:
            print(f"{path}: {patch_file(path)}")
        except (OSError, TTLibError, ValueError, KeyError) as error:
            print(f"{path}: {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
