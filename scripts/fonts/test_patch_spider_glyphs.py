import importlib.util
import itertools
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

SCRIPT = Path(__file__).with_name("patch-spider-glyphs.py")
WEB, ROBOT = 0xF0BCA, 0xF167A
FRAMES = range(0xF2120, 0xF2124)


def outline(*contours):
    pen = TTGlyphPen(None)
    for pts in contours:
        pen.moveTo(pts[0])
        for pt in pts[1:]:
            pen.lineTo(pt)
        pen.closePath()
    return pen.glyph()


def rect(x, y, width, height):
    return [(x, y), (x, y + height), (x + width, y + height), (x + width, y)]


def build_font(path, *, conflict=False, family="CaskaydiaCove Nerd Font"):
    glyphs = {
        ".notdef": outline(),
        "A": outline([(70, 0), (600, 1500), (1130, 0)]),
        "web": outline(rect(0, -160, 1832, 1748)),
        "robot": outline(
            rect(1068, 242, 340, 340), rect(472, 242, 340, 340),
            [(0, 0), (0, 700), (100, 800), (940, 1560), (1780, 800), (1880, 700), (1880, 0), (940, -142)],
            [(172, 26), (400, 960), (900, 966), (1500, 800), (1708, 26), (900, 30)],
        ),
    }
    cmap = {ord("A"): "A", WEB: "web", ROBOT: "robot"}
    if conflict:
        cmap[FRAMES[1]] = "A"
    fb = FontBuilder(2048, isTTF=True)
    fb.setupGlyphOrder(list(glyphs))
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (1200, getattr(glyph, "xMin", 0)) for name, glyph in glyphs.items()})
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    fb.setupNameTable({"familyName": family, "styleName": "Regular", "uniqueFontIdentifier": "Fixture"})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.save(path)


def contours(font, name):
    glyf = font["glyf"]
    coordinates, ends, _ = glyf[name].getCoordinates(glyf)
    return [list(coordinates[start:end]) for start, end in itertools.pairwise([0, *(n + 1 for n in ends)])]


class PatchSpiderGlyphs(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.font = Path(self.scratch.name) / "fixture.ttf"
        self.backup = self.font.with_suffix(".ttf.spider-original")

    def run_patch(self, *paths):
        return subprocess.run([sys.executable, SCRIPT, *(paths or (self.font,))], capture_output=True, text=True)

    def test_patches_only_the_web_and_four_robot_frames(self):
        build_font(self.font)
        self.font.chmod(0o640)
        original = self.font.read_bytes()
        result = self.run_patch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.backup.read_bytes(), original)
        self.assertEqual(stat.S_IMODE(self.font.stat().st_mode), 0o640)
        with TTFont(self.backup) as old, TTFont(self.font) as new:
            cmap = new.getBestCmap()
            self.assertEqual(set(cmap) - set(old.getBestCmap()), set(FRAMES))
            new_names = [cmap[cp] for cp in FRAMES]
            self.assertEqual(new.getGlyphOrder(), old.getGlyphOrder() + new_names)
            for name in old.getGlyphOrder():
                if name != "web":
                    self.assertEqual(contours(old, name), contours(new, name), name)
                    self.assertEqual(old["hmtx"][name], new["hmtx"][name], name)
            web = contours(new, "web")
            self.assertNotEqual(web, contours(old, "web"))
            self.assertEqual(len(web), 10)  # Four round-capped axes and three rings with holes.
            self.assertEqual(new["hmtx"]["web"][0], old["hmtx"]["web"][0])
            center, left, right, closed = [contours(new, name) for name in new_names]
            self.assertEqual(center, contours(old, "robot"))
            for shifted in (left, right, closed):
                self.assertEqual(shifted[2:], center[2:])
            for i in (0, 1):
                self.assertEqual(left[i], [(x - 130, y) for x, y in center[i]])
                self.assertEqual(right[i], [(x + 130, y) for x, y in center[i]])
                self.assertLess(max(y for x, y in closed[i]) - min(y for x, y in closed[i]), 60)
            self.assertTrue(all(new["hmtx"][name][0] == old["hmtx"]["robot"][0] for name in new_names))
            for table in new["cmap"].tables:
                if table.isUnicode() and table.format == 12:
                    self.assertTrue(all(table.cmap[cp] == cmap[cp] for cp in FRAMES))

    def test_stages_outside_the_macos_font_directory(self):
        home = self.font.parent
        fonts = home / "Library" / "Fonts"
        font = fonts / "Family" / "fixture.ttf"
        font.parent.mkdir(parents=True)
        build_font(font)
        spec = importlib.util.spec_from_file_location("patch_spider_glyphs", SCRIPT)
        patcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(patcher)
        with patch.dict(os.environ, HOME=str(home)), patch.object(patcher.os, "replace", wraps=os.replace) as replace:
            patcher.patch_file(font)
        replace.assert_called_once()
        staged, dest = replace.call_args.args
        self.assertEqual(dest, font)
        self.assertFalse(staged.is_relative_to(fonts), staged)
        self.assertEqual(staged.suffix, ".tmp")
        with TTFont(font) as installed:
            self.assertTrue(all(cp in installed.getBestCmap() for cp in FRAMES))

    def test_second_run_leaves_both_files_alone(self):
        build_font(self.font)
        result = self.run_patch()
        self.assertEqual(result.returncode, 0, result.stderr)
        snapshots = [(p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for p in (self.font, self.backup)]
        result = self.run_patch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("already patched", result.stdout)
        self.assertEqual(snapshots, [(p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for p in (self.font, self.backup)])

    def test_preserves_an_existing_backup(self):
        build_font(self.font)
        self.backup.write_bytes(b"first backup")
        result = self.run_patch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.backup.read_bytes(), b"first backup")

    def test_rejects_an_occupied_frame_codepoint_without_writing(self):
        build_font(self.font, conflict=True)
        original = self.font.read_bytes()
        result = self.run_patch()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("U+F2121", result.stderr)
        self.assertEqual(self.font.read_bytes(), original)
        self.assertFalse(self.backup.exists())

    def test_rejects_other_font_families_even_with_the_source_glyphs(self):
        build_font(self.font, family="Unrelated Nerd Font")
        original = self.font.read_bytes()
        result = self.run_patch()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("CaskaydiaCove Nerd Font", result.stderr)
        self.assertEqual(self.font.read_bytes(), original)
        self.assertFalse(self.backup.exists())


if __name__ == "__main__":
    unittest.main()
