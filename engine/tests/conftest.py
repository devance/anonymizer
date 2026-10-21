import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def pytest_sessionstart(session):
    from engine.paths import TESSDATA

    if not (TESSDATA / "fra.traineddata").exists():
        pytest.exit(f"OCR models missing from {TESSDATA}: run engine/scripts/fetch_models.py", returncode=4)
