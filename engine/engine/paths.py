"""Where the engine's data files live: next to the package in a checkout, inside the bundle when frozen."""

from __future__ import annotations

import os
import sys
from pathlib import Path

BASE = Path(sys._MEIPASS) if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[1]
FONT_DIR = Path(os.environ.get("ANON_FONT_DIR") or BASE / "fonts")
TESSDATA = Path(os.environ.get("ANON_TESSDATA") or BASE / "tessdata")
