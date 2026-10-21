# Devance Anonymiseur

Remplace les noms, adresses et numéros d'un document par des valeurs fictives
réalistes, pour le confier à n'importe quelle IA. Ce que l'IA vous rend, même
reformulé, retrouve ses vraies valeurs. Tout se passe sur votre ordinateur.

Replaces the names, addresses and numbers in a document with realistic fakes,
so it can be handed to any AI. Whatever comes back, even reworded, gets the
real values put back. Everything runs on your computer.

**[Download / Télécharger](https://github.com/devance/anonymizer/releases/latest)**:
macOS 14+ on Apple Silicon, Windows 10 and 11 (64-bit). Beta.

- No account, no server, no telemetry. Projects are encrypted on disk with a
  password chosen at first launch.
- Free software under the [GNU AGPL 3.0](LICENSE), by [Devance](https://devance.ca).

```
document ─> rules + known values + local model find people, addresses, IDs
         ─> review ─> anonymized copy ─> any AI
real values back <─ restore <─ fakes recognized (exact + reworded) <──┘
```

## How it works

- **Projects** group documents that share people. Within a project the same
  real value always gets the same fake, and fakes are unique across the whole
  database, so a document coming back from an AI goes to the project its
  fakes came from.
- **Detection**: rules for structured identifiers (SIN, phones, postal codes,
  cards, IBAN, RAMQ, dates of birth), the values already known in the project,
  and a small model in the document engine for names, addresses and
  organizations. An optional deep check runs Gemma locally through llama.cpp.
- **Fakes** are Québec-flavoured and shaped like the original: street names
  with the same article ("rue des Érables" → "rue des Bouleaux"), postal codes
  in the same province, phones in the fictional 555-01XX range, SINs with a
  never-issued prefix, dates of birth in the same year. A fake never equals a
  real value of its project.
- **Restore** is deterministic: every fake is searched for in the shapes an AI
  writes it (last name alone, initials, all caps, a reformatted phone, an
  address translated to English).
- **Files**: PDFs come back as same-looking PDFs, retypeset in the document's
  own fonts. Scans and photos are OCR'd (French and English) and patched in the
  pixels. Word files are rewritten with tracked changes, authors and properties
  removed. Every anonymized PDF is checked for leftovers in its text, links,
  metadata, barcodes, and in an OCR of each rendered page.

## Security

- **Keys**: password → Argon2id (256 MiB) → a key that wraps a random master
  key (AES-256-GCM). The database key and the file key are derived from the
  master key, which lives only in the Rust side of the app and is erased when
  the app locks. A forgotten password can't be recovered.
- **At rest**: the database is SQLCipher 4 (AES-256), every stored file is
  AES-256-GCM. The diagnostic log holds ids, steps, timings and counts, never
  document text, names or detected values.
- **In use**: the app locks after 30 minutes idle unless auto-unlock is on. The
  document engine works in memory, with no temporary files. Helpers listen on
  127.0.0.1 with a random token per launch.
- **Network**: none, except the model downloads you start (checked by SHA-256).

## Layout

| Path | What |
|---|---|
| `packages/core` | Pure TypeScript: normalization, rules, fakes, matching, merging. |
| `packages/pipeline` | Detection prompts, model clients (llama.cpp, Ollama), prepare, analyze, render, route. |
| `packages/backend` | The service the app runs: projects, documents, fakes, jobs and the API. |
| `packages/design` | A copy of the Devance design system: CSS, the Geist font, Phosphor icons. |
| `ui` | React UI. |
| `engine` | Python document engine: PyMuPDF, OCR with Tesseract data, Word files, the detection model. Frozen with PyInstaller as the app's helper. |
| `desktop` | Tauri 2 shell (Rust): vault, SQLCipher database, encrypted files, helper processes, model downloads, packaging scripts. |
| `fixtures` | Synthetic documents for tests and the detection benchmark. Never real ones. |

## Development

```bash
npm install
npm test && npm run typecheck
(cd desktop/src-tauri && cargo test)
engine/scripts/build.sh                  # venv, OCR and detection models, PyInstaller
engine/.venv/bin/pytest -q engine/tests
(cd desktop && npx tauri dev)            # the app, with hot reload of the UI
desktop/e2e/run.sh                       # scripted run in the debug app, throwaway data folder
```

Rust comes from [rustup](https://rustup.rs); the engine needs Python 3.12.
Releases are built by `.github/workflows/release.yml` (`desktop/scripts/release-mac.sh`
and `release-windows.sh`).

## License

GNU Affero General Public License 3.0 only, © 2026 Devance. See [LICENSE](LICENSE)
and the third-party notices shipped with the app (Settings > About). Local API
clients and examples (`clients/`, `examples/`) will be under Apache 2.0.
"Devance" is a trademark of Devance; forks must use another name.

Contributions are welcome under the [CLA](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md).
Security issues: use **Report a vulnerability** in the Security tab, not a public issue.
