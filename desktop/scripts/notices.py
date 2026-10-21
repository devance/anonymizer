"""Writes THIRD_PARTY_NOTICES.txt: every Rust crate, npm package in the UI
bundle, Python package in the engine, and bundled asset, with its licence
text. Run at release time (scripts/release-mac.sh); the app shows the file in
Settings > About.

    python3 desktop/scripts/notices.py [engine-venv-site-packages] > THIRD_PARTY_NOTICES.txt
"""
import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LICENSE_NAMES = ("LICENSE", "LICENSE.md", "LICENSE.txt", "LICENSE-MIT", "LICENSE-APACHE", "COPYING", "LICENCE", "NOTICE")


def licence_texts(directory):
    out = []
    for name in sorted(os.listdir(directory)) if os.path.isdir(directory) else []:
        if name.upper().startswith(tuple(n.upper() for n in LICENSE_NAMES)):
            try:
                out.append(open(os.path.join(directory, name), encoding="utf-8", errors="replace").read().strip())
            except OSError:
                pass
    return out


def section(name, version, licence, texts):
    return (f"{name} {version}".strip(), licence or "", "\n\n".join(texts))


def render(entries):
    """Packages sharing the exact same licence text are listed together, text once."""
    groups = {}
    for name, licence, text in entries:
        groups.setdefault((licence, text), []).append(name)
    out = []
    for (licence, text), names in sorted(groups.items(), key=lambda kv: kv[1][0].lower()):
        body = text or f"(no licence file in the package; licence: {licence})"
        out.append(f"{'=' * 78}\n{', '.join(names)}\n{licence}\n{'-' * 78}\n{body}\n")
    return out


def rust():
    meta = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--format-version", "1", "--manifest-path", os.path.join(ROOT, "desktop/src-tauri/Cargo.toml")],
        env={**os.environ, "PATH": os.path.expanduser("~/.cargo/bin") + os.pathsep + os.environ["PATH"]},
    ))
    # Only what the release binary links: normal deps reachable from the root.
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    root = meta["resolve"]["root"]
    seen, stack = set(), [root]
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        for d in nodes[pid]["deps"]:
            if any(k["kind"] in (None, "build") for k in d["dep_kinds"]):
                stack.append(d["pkg"])
    pkgs = [p for p in meta["packages"] if p["id"] in seen and p["id"] != root]
    for p in sorted(pkgs, key=lambda p: (p["name"], p["version"])):
        directory = os.path.dirname(p["manifest_path"])
        yield section(p["name"], p["version"], p.get("license"), licence_texts(directory))
        if p["name"] == "libsqlite3-sys":
            yield section("SQLCipher (bundled by libsqlite3-sys)", "", "BSD-3-Clause", licence_texts(os.path.join(directory, "sqlcipher")))


def npm():
    lock = json.load(open(os.path.join(ROOT, "package-lock.json")))
    # Runtime dependencies of the UI and the packages it bundles.
    wanted, stack = set(), ["react", "react-dom", "pdfjs-dist", "hono", "@tauri-apps/api", "@tauri-apps/plugin-opener", "scheduler"]
    pk = lock["packages"]
    while stack:
        name = stack.pop()
        if name in wanted:
            continue
        info = pk.get(f"node_modules/{name}")
        if not info:
            continue
        wanted.add(name)
        stack.extend((info.get("dependencies") or {}).keys())
    for name in sorted(wanted):
        info = pk[f"node_modules/{name}"]
        yield section(name, info.get("version", ""), info.get("license"), licence_texts(os.path.join(ROOT, "node_modules", name)))


def shipped_python_packages():
    """Names in engine/requirements.lock: what PyInstaller freezes, without the dev tools."""
    lock = open(os.path.join(ROOT, "engine", "requirements.lock")).read()
    return {re.sub(r"[-_.]+", "-", m.lower()) for m in re.findall(r"^([A-Za-z0-9_.-]+)==", lock, re.M)}


def python(site):
    shipped = shipped_python_packages()
    for dist in sorted(glob.glob(os.path.join(site, "*.dist-info"))):
        meta = open(os.path.join(dist, "METADATA"), encoding="utf-8", errors="replace").read().split("\n\n")[0]
        fields = dict(line.split(": ", 1) for line in meta.splitlines() if ": " in line)
        name, version = fields.get("Name", os.path.basename(dist)), fields.get("Version", "")
        if re.sub(r"[-_.]+", "-", name.lower()) not in shipped:
            continue
        classifiers = [line.split(" :: ")[-1] for line in meta.splitlines() if line.startswith("Classifier: License ::")]
        licence = fields.get("License-Expression") or fields.get("License") or ", ".join(classifiers)
        texts = licence_texts(dist) + licence_texts(os.path.join(dist, "licenses")) + licence_texts(os.path.join(dist, "licenses", "LICENSES"))
        yield section(name, version, licence, texts)
    # The interpreter PyInstaller bundles (libpython), from the venv's base Python:
    # site-packages is .venv/lib/python3.x/site-packages, or .venv/Lib/site-packages on Windows.
    cfg = next(p for p in (os.path.join(site, *[".."] * n, "pyvenv.cfg") for n in (3, 2)) if os.path.exists(p))
    venv = dict(line.split(" = ", 1) for line in open(cfg).read().splitlines() if " = " in line)
    home = venv.get("home", "")
    for path in (glob.glob(os.path.join(home, "..", "lib", "python3*", "LICENSE.txt")) + glob.glob(os.path.join(home, "LICENSE.txt")))[:1]:
        yield section("Python", venv.get("version", ""), "PSF-2.0", [open(path, encoding="utf-8", errors="replace").read().strip()])


def fonts():
    """The engine's fonts: OFL-1.1 wants its text next to every copy."""
    for path in sorted(glob.glob(os.path.join(ROOT, "engine", "fonts", "*", "*"))):
        name = os.path.basename(path)
        if name.upper().startswith(("LICENSE", "OFL")) or name.endswith("-OFL.txt"):
            family = name.split("-")[0] if name.endswith("-OFL.txt") else os.path.basename(os.path.dirname(path)).capitalize()
            yield section(f"{family} fonts", "", "OFL-1.1", [open(path, encoding="utf-8", errors="replace").read().strip()])


ASSETS = [
    ("llama.cpp", "MIT", "https://github.com/ggml-org/llama.cpp"),
    ("LLVM OpenMP runtime (llama-server on Windows)", "Apache-2.0 WITH LLVM-exception", "https://openmp.llvm.org"),
    ("Tesseract OCR language data (tessdata_fast)", "Apache-2.0", "https://github.com/tesseract-ocr/tessdata_fast"),
    ("nym-pii-multilingual-small detection model (Wismut, from jhu-clsp/mmBERT-small)", "MIT", "https://huggingface.co/Wismut/nym-pii-multilingual-small"),
    ("ONNX Runtime", "MIT", "https://github.com/microsoft/onnxruntime"),
    ("INSEE, Fichier des prénoms (first-name list in engine/lexicon)", "Licence Ouverte 2.0", "https://www.insee.fr/fr/statistiques/7633685"),
    ("MuPDF / PyMuPDF", "AGPL-3.0", "https://mupdf.com"),
    ("  in MuPDF: FreeType", "FTL", "https://freetype.org"),
    ("  in MuPDF: HarfBuzz", "MIT", "https://github.com/harfbuzz/harfbuzz"),
    ("  in MuPDF: jbig2dec", "AGPL-3.0", "https://jbig2dec.com"),
    ("  in MuPDF: OpenJPEG", "BSD-2-Clause", "https://www.openjpeg.org"),
    ("  in MuPDF: lcms2", "MIT", "https://www.littlecms.com"),
    ("  in MuPDF: libjpeg", "IJG", "https://www.ijg.org"),
    ("  in MuPDF: zlib", "Zlib", "https://zlib.net"),
    ("  in MuPDF: Brotli", "MIT", "https://github.com/google/brotli"),
    ("  in MuPDF: Tesseract", "Apache-2.0", "https://github.com/tesseract-ocr/tesseract"),
    ("  in MuPDF: Leptonica", "BSD-2-Clause", "http://www.leptonica.org"),
    ("  in MuPDF: zxing-cpp", "Apache-2.0", "https://github.com/zxing-cpp/zxing-cpp"),
    ("  in MuPDF: extract", "AGPL-3.0", "https://github.com/ArtifexSoftware/extract"),
    ("Liberation fonts", "OFL-1.1", "https://github.com/liberationfonts/liberation-fonts"),
    ("Carlito font", "OFL-1.1", "https://github.com/googlefonts/carlito"),
    ("Caladea font", "OFL-1.1", "https://github.com/huertatipografica/Caladea"),
    ("Geist font", "OFL-1.1", "https://github.com/vercel/geist-font"),
    ("Phosphor icons", "MIT", "https://github.com/phosphor-icons/core"),
    ("SQLCipher", "BSD-3-Clause", "https://www.zetetic.net/sqlcipher/"),
    ("OpenSSL", "Apache-2.0", "https://www.openssl.org"),
    ("Gemma 4 models (downloaded by the user, not bundled)", "Apache-2.0", "https://ai.google.dev/gemma"),
]

if __name__ == "__main__":
    # Windows consoles default to cp1252; the licence texts aren't all Latin-1.
    sys.stdout.reconfigure(encoding="utf-8")
    print("Devance Anonymiseur: third-party software\n")
    print("Devance Anonymiseur is free software under the GNU Affero General Public License 3.0.")
    print("Source code: https://github.com/devance/anonymizer\n")
    print("Bundled components:")
    for name, lic, url in ASSETS:
        print(f"  {name}: {lic}, {url}")
    print()
    # FreeType's licence (FTL) asks for this credit in the documentation.
    print("Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights reserved.\n")
    entries = list(rust()) + list(npm()) + list(fonts()) + (list(python(sys.argv[1])) if len(sys.argv) > 1 else [])
    for block in render(entries):
        print(block)
