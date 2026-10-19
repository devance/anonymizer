# PyInstaller spec for the frozen engine (run by scripts/build.sh).
# onedir; on macOS wrapped in AnonEngine.app, a background app (no Dock icon)
# the desktop app starts as a sidecar: Contents/MacOS/anon-engine.
# Not signed here: signing happens when the desktop app is packaged.

import os
import sys

from PyInstaller.utils.hooks import collect_dynamic_libs, collect_submodules

ROOT = SPECPATH

a = Analysis(
    [os.path.join(ROOT, "engine", "desktop.py")],
    pathex=[ROOT],
    binaries=collect_dynamic_libs("pymupdf") + collect_dynamic_libs("pillow_heif") + collect_dynamic_libs("zxingcpp") + collect_dynamic_libs("onnxruntime"),
    datas=[(os.path.join(ROOT, "fonts"), "fonts"), (os.path.join(ROOT, "tessdata"), "tessdata"), (os.path.join(ROOT, "ner"), "ner")],
    hiddenimports=collect_submodules("engine")
    # fontTools loads table modules by tag name, uvicorn its loop and protocol by string.
    + collect_submodules("fontTools.ttLib.tables")
    + collect_submodules("fontTools.subset")
    + ["uvicorn.logging", "uvicorn.loops.asyncio", "uvicorn.protocols.http.h11_impl", "uvicorn.lifespan.off"],
    excludes=[
        "tkinter", "_tkinter", "turtle", "turtledemo", "idlelib", "lib2to3", "test", "pydoc_data",
        "pytest", "_pytest", "httpx", "PyInstaller", "setuptools", "_distutils_hack", "pkg_resources",
        # uvicorn's optional speedups and websockets, never configured here
        "uvloop", "httptools", "websockets", "wsproto", "watchfiles", "dotenv", "yaml",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="anon-engine",
    console=True,  # stdout carries the port line to the app
    debug=False,
    strip=False,
    upx=False,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="anon-engine")

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="AnonEngine.app",
        bundle_identifier="ca.devance.anonymizer.engine",
        version=os.environ.get("ANON_ENGINE_VERSION", "0.0.0"),
        info_plist={"LSUIElement": True},
    )
