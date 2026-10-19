# Contributing

Pour contribuer en français : les tickets et les demandes de fusion peuvent être
écrits en français ou en anglais.

## Before you start

- For anything bigger than a fix, open an issue first so we agree on the approach.
- Security problems: do not open a public issue. Use **Report a vulnerability** in
  the repository's Security tab.

## License and CLA

- The app is free software under the GNU AGPL 3.0 ([LICENSE](LICENSE)). Code in
  `clients/` and `examples/` is under Apache 2.0 so it can go into closed code; each
  of those folders has its own LICENSE file.
- Before your first pull request is merged, you accept the
  [Contributor License Agreement](CLA.md) once. The CLA bot comments on the pull
  request with the sentence to post. You keep the copyright on your work; the CLA lets
  Devance also offer the anonymizer under a commercial license to organizations that
  cannot use the AGPL, which pays for the project.
- Code you did not write: say in the pull request where it comes from and under which
  license. Licenses accepted for a new dependency of the app: MIT, BSD, ISC, Zlib,
  Apache-2.0, MPL-2.0, LGPL, GPL-2.0-or-later, GPL-3.0, AGPL-3.0, OFL-1.1 (fonts). In
  `clients/` and `examples/`: MIT, BSD, ISC, Zlib, Apache-2.0. Anything else is
  discussed in an issue first.

## Rules

- **Synthetic data only.** Fixtures, tests, screenshots, issues and commit messages
  never contain real documents or real people's names, addresses or numbers.
- **Tests pass.** `npm test && npm run typecheck`, plus the Rust and engine tests
  when you touch them (commands in [README.md](README.md#development)).
- **French first.** Every UI string goes through `ui/src/i18n.ts`, in French and
  English, with no em or en dashes.
- **Design** follows [ui/DESIGN.md](ui/DESIGN.md).
- **Nothing real leaves the machine.** No network calls besides model downloads, no
  document content in logs, no document data in browser storage, no temporary files
  with document content.
