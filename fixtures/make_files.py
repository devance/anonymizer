"""Builds the binary fixtures from text/assurance-habitation.txt (made-up people).

    engine/.venv/bin/python fixtures/make_files.py
"""
from pathlib import Path

import pymupdf as fitz

ROOT = Path(__file__).parent
FONTS = ROOT.parent / "engine" / "fonts" / "liberation"
lines = (ROOT / "text" / "assurance-habitation.txt").read_text(encoding="utf-8").splitlines()

doc = fitz.open()
page = doc.new_page()
page.insert_font(fontname="lsans", fontfile=str(FONTS / "LiberationSans-Regular.ttf"))
page.insert_font(fontname="lsansb", fontfile=str(FONTS / "LiberationSans-Bold.ttf"))
page.insert_font(fontname="lserif", fontfile=str(FONTS / "LiberationSerif-Regular.ttf"))
page.draw_rect(fitz.Rect(50, 40, 545, 80), color=None, fill=(0.18, 0.36, 0.31))
page.insert_text((62, 66), lines[0], fontsize=16, fontname="lsansb", color=(1, 1, 1))
y = 110
for line in lines[1:]:
    page.insert_text((62, y), line.replace("—", "-"), fontsize=11, fontname="lserif" if line.startswith(("Monsieur", "Votre", "Mme", "courti", "J.-F.")) else "lsans")
    y += 19
page.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(330, 186, 470, 198), "uri": "mailto:jf.tremblay@videotron.example"})
doc.set_metadata({"author": "Jean-François Tremblay", "title": "Renouvellement Tremblay"})
# Subset like real-world PDFs: the fonts only hold the glyphs this page uses.
doc.subset_fonts()
(ROOT / "files" / "assurance-habitation.pdf").write_bytes(doc.tobytes(garbage=4, deflate=True))

pix = doc[0].get_pixmap(dpi=200, colorspace=fitz.csGRAY)
scan = fitz.open()
p = scan.new_page(width=doc[0].rect.width, height=doc[0].rect.height)
p.insert_image(p.rect, stream=pix.tobytes("png"))
(ROOT / "files" / "assurance-habitation-scan.pdf").write_bytes(scan.tobytes(garbage=4, deflate=True))
print("ok")
