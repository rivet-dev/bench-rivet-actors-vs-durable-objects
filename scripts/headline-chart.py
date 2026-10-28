"""Draws the headline chart (report/charts/headline.svg and .png, 1600x900) from the raw samples
of one run: per metric, a p50 column for each platform with a thin line up to the p99, and the
p50 multiple above each group. The numbers are the same as the README headline table.

Requirements: Python 3 with Pillow, headless Chromium on PATH as `chromium`, and the Manrope font
(set MANROPE_TTF, default ~/.local/share/fonts/Manrope.ttf; used for text measurement and must
also be installed for Chromium to render it).

Usage: python3 scripts/headline-chart.py [results/<date>] [report-dir]
"""

import base64
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageFont

W, H = 1600, 900

ROOT = Path(__file__).resolve().parent.parent
RESULTS = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "results" / "2026-10-28"
REPORT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "report"
CHARTS = REPORT / "charts"
FONT_FILE = Path(os.environ.get("MANROPE_TTF", Path.home() / ".local/share/fonts/Manrope.ttf"))

PORCELAIN = "#EFEFEF"
INK = "#1B1916"
INK_SOFT = "#56524A"
DIM = "#9A958B"
# Cloudflare's columns, lines and text use an orange a little deeper than the brand orange so text
# holds contrast on the light page. The logo keeps the brand orange.
CF_TEXT = "#E86A10"
CF_ORANGE = "#F38020"
WHITE = "#FFFFFF"
FONT = "Manrope, 'Helvetica Neue', Arial, sans-serif"

# Logos live next to the chart: the Rivet icon, and the Cloudflare mark from simple-icons (CC0).
RIVET_ICON_SVG = (ROOT / "report" / "charts" / "rivet-icon.svg").read_text()
CLOUDFLARE_PATH = re.search(r'd="([^"]+)"', (ROOT / "report" / "charts" / "cloudflare-icon.svg").read_text()).group(1)

WEIGHT_NAMES = {200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold"}

SHADOW = (
	'<filter id="tileShadow" x="-30%" y="-30%" width="160%" height="160%">'
	'<feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.10"/></filter>'
)


def text_width(s, size, weight=500):
	"""Approximate rendered width, used only for layout decisions."""
	font = ImageFont.truetype(str(FONT_FILE), size)
	font.set_variation_by_name(WEIGHT_NAMES[weight])
	return font.getlength(s)


def svg(body, bg, defs=""):
	return (
		f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
		f"<defs>{defs}</defs>"
		f'<rect width="{W}" height="{H}" fill="{bg}"/>{body}</svg>\n'
	)


def text(x, y, s, size, fill, weight=500, anchor="start", extra=""):
	return (
		f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" '
		f'fill="{fill}" text-anchor="{anchor}" dominant-baseline="central" {extra}>{s}</text>'
	)


def rivet_tile(x, y, size):
	data = base64.b64encode(RIVET_ICON_SVG.encode()).decode()
	return f'<image x="{x}" y="{y}" width="{size}" height="{size}" href="data:image/svg+xml;base64,{data}"/>'


def cloudflare_tile(x, y, size):
	"""The Cloudflare cloud centered in a rounded white tile. The mark spans the full 24-unit width
	of its viewBox and y 6.58 to 17.43, so it is scaled to 68% of the tile and centered on its middle."""
	scale = size * 0.68 / 24
	tx = x + size * 0.16
	ty = y + size / 2 - 12.0 * scale
	return (
		f'<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="{size * 0.3}" fill="{WHITE}" filter="url(#tileShadow)"/>'
		f'<path transform="translate({tx:.2f},{ty:.2f}) scale({scale:.4f})" d="{CLOUDFLARE_PATH}" fill="{CF_ORANGE}"/>'
	)


def ms(v):
	if v >= 10 or v == int(v):
		return f"{v:,.0f} ms"
	return f"{v:.2f} ms"


def pct(xs, p):
	"""Nearest rank, the same definition as scripts/report.mjs."""
	ordered = sorted(xs)
	return ordered[min(len(ordered) - 1, max(0, math.ceil(p / 100 * len(ordered)) - 1))]


def nice_ticks(peak):
	"""Three or four round tick values from zero up to at most peak."""
	for step in (1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500):
		if peak / step <= 4:
			return [step * k for k in range(int(peak / step) + 1)]
	return [0, peak]


def load_samples():
	"""Raw per-request samples in ms: (label, Rivet samples, Cloudflare samples)."""

	def rivet(name):
		rows = [json.loads(line) for line in (RESULTS / "rivet" / name).read_text().splitlines() if line]
		return [r["totalMs"] for r in rows if r.get("status") == 200]

	def cloudflare(pattern, scenario, kind):
		out = []
		for f in sorted((RESULTS / "cloudflare").glob(pattern)):
			for s in json.loads(f.read_text())["samples"]:
				if s.get("scenario") != scenario or s.get("kind") != kind or s.get("error") or "ms" not in s:
					continue
				if kind == "cold" and s.get("cold") is not True:
					continue
				out.append(s["ms"])
		return out

	rivet_warm = rivet("warm-warm.ndjson")
	cloud_warm = cloudflare("sql-*.json", "ping/1", "sql")
	# Each side's median no-op round trip is its baseline. It is subtracted from every create and
	# write sample, so those groups show the work itself rather than the hop to reach the actor.
	rivet_base, cloud_base = pct(rivet_warm, 50), pct(cloud_warm, 50)

	def net(xs, base):
		return [max(x - base, 0.0) for x in xs]

	return [
		("Create + first request", net(rivet("create-create.ndjson"), rivet_base), net(cloudflare("create-*.json", "unique/raw", "cold"), cloud_base)),
		("SQLite write", net(rivet("sql-write-sql-write-woken.ndjson"), rivet_base), net(cloudflare("sql-*.json", "insert/1", "sql"), cloud_base)),
		("Request from your backend", rivet_warm, cloud_warm),
	]


def chart(data):
	bg, fg, muted, dim = PORCELAIN, INK, INK_SOFT, DIM
	out = []

	# Title: [Rivet] Actors (vs) [Cloudflare] Durable Objects, centered as one unit.
	size, icon, gap = 56, 62, 16
	parts = [(rivet_tile, "Actors"), None, (cloudflare_tile, "Durable Objects")]
	widths = [icon + gap + text_width("Actors", size, 800), 20 + 68 + 20, icon + gap + text_width("Durable Objects", size, 800)]
	x = (W - sum(widths)) / 2
	for part, w in zip(parts, widths):
		if part is None:
			out.append(text(x + 20 + 34, 81, "VS", 20, muted, 700, "middle", extra='letter-spacing="2"'))
		else:
			out.append(part[0](x, 80 - icon / 2, icon))
			out.append(text(x + icon + gap, 80, part[1], size, fg, 800))
		x += w

	top, base = 330, 700
	group_w, col_w, col_gap = 500, 96, 56
	x0 = (W - 3 * group_w) / 2
	for i, (label, rivet, cloud) in enumerate(data):
		gl = x0 + i * group_w
		gx = gl + group_w / 2
		peak = max(pct(rivet, 99), pct(cloud, 99))

		def y_of(v, peak=peak):
			return base - v / peak * (base - top)

		# The p50 multiple, large, over each group.
		mult = f"{pct(cloud, 50) / pct(rivet, 50):.0f}×"
		mw = text_width(mult, 96, 800)
		fw = text_width("faster", 30, 600)
		mx = gx - (mw + 14 + fw) / 2
		out.append(text(mx, 216, mult, 96, CF_TEXT, 800))
		out.append(text(mx + mw + 14, 236, "faster", 30, muted, 600))

		# Horizontal gridlines with their values at the group's left edge. A tick too close to the
		# top would run through the p99 label there, so it is left out.
		for t in nice_ticks(peak):
			yt = y_of(t)
			if t and yt - top < 30:
				continue
			out.append(f'<line x1="{gl + 70}" y1="{yt}" x2="{gl + group_w - 40}" y2="{yt}" stroke="{fg}" stroke-opacity="0.10" stroke-width="2"/>')
			out.append(text(gl + 60, yt, f"{t:g} ms" if t else "0", 18, dim, 600, "end"))

		for j, (xs, fill, tile) in enumerate([(rivet, INK, rivet_tile), (cloud, CF_TEXT, cloudflare_tile)]):
			cx = gx + 15 + (j - 0.5) * (col_w + col_gap)
			p50, p99 = pct(xs, 50), pct(xs, 99)
			y50, y99 = y_of(p50), y_of(p99)
			line = f'stroke="{fill}" stroke-opacity="0.7" stroke-width="3"'
			out.append(f'<line x1="{cx}" y1="{y50}" x2="{cx}" y2="{y99}" {line}/>')
			out.append(f'<line x1="{cx - 12}" y1="{y99}" x2="{cx + 12}" y2="{y99}" {line}/>')
			h = max(base - y50, 6)
			out.append(f'<rect x="{cx - col_w / 2}" y="{base - h}" width="{col_w}" height="{h}" rx="8" fill="{fill}"/>')
			# The p50 just above the column on a translucent patch of the page color.
			lab = ms(p50)
			lw = text_width(lab, 26, 800)
			ly = base - h - 26
			out.append(f'<rect x="{cx - lw / 2 - 10}" y="{ly - 18}" width="{lw + 20}" height="36" rx="9" fill="{bg}" fill-opacity="0.75"/>')
			out.append(text(cx, ly, lab, 26, fill, 800, "middle"))
			if j == 1:
				out.append(text(cx + 20, y99, f"p99 {ms(p99)}", 20, dim, 500))
			out.append(tile(cx - 20, base + 20, 40))
		out.append(f'<line x1="{gl + 70}" y1="{base}" x2="{gl + group_w - 40}" y2="{base}" stroke="{fg}" stroke-opacity="0.25" stroke-width="2"/>')
		label_size = 30 if text_width(label, 30, 700) <= group_w - 40 else 26
		out.append(text(gx + 15, base + 112, label, label_size, fg, 700, "middle"))

	out.append(text(W / 2, H - 30, f"Column: p50. Line: p99. Create and write are net of each side\u2019s baseline (median no-op round trip). Raw samples in results/{RESULTS.name}.", 18, dim, 500, "middle"))
	return svg("".join(out), bg, SHADOW)


def render(svg_path: Path, png_path: Path):
	"""Headless Chromium screenshot; the viewport loses some height, so the window is oversized and cropped."""
	with tempfile.TemporaryDirectory() as tmp:
		html_path = Path(tmp) / "chart.html"
		html_path.write_text(
			"<!doctype html><html><head><style>html,body{margin:0}</style></head><body>"
			+ svg_path.read_text()
			+ "</body></html>"
		)
		subprocess.run(
			[
				"chromium", "--headless", "--no-sandbox", "--hide-scrollbars",
				f"--window-size={W},{H + 200}", f"--screenshot={png_path.resolve()}", f"file://{html_path}",
			],
			check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
		)
	Image.open(png_path).crop((0, 0, W, H)).save(png_path)


if __name__ == "__main__":
	data = load_samples()
	for label, rivet, cloud in data:
		print(
			f"{label}: Rivet p50 {pct(rivet, 50)} p99 {pct(rivet, 99)} (n={len(rivet)}); "
			f"Cloudflare p50 {pct(cloud, 50)} p99 {pct(cloud, 99)} (n={len(cloud)}); "
			f"{pct(cloud, 50) / pct(rivet, 50):.1f}x"
		)
	CHARTS.mkdir(parents=True, exist_ok=True)
	svg_path = CHARTS / "headline.svg"
	png_path = CHARTS / "headline.png"
	svg_path.write_text(chart(data))
	render(svg_path, png_path)
	print(f"wrote {svg_path} and {png_path}")
