# @devance/design (copy)

A copy of the Devance design system, `devance/design` v0.1.1 (commit a7f10cb): the CSS
(tokens, base, components), the Geist font, the Phosphor icons and the Devance marks the
app uses. It lives here so this repository builds on its own, without access to
`devance/design`.

Don't edit these files here. Change `devance/design`, tag a release, then:

```bash
packages/design/update.sh v0.1.2
npm install
```

In this repository the copy is under the repository's license (AGPL 3.0), except the
Geist font (SIL Open Font License, `fonts/LICENSE-geist.txt`) and the Phosphor icons (MIT,
`icons/LICENSE-phosphor.txt`). The Devance name and marks in `brand/` are not licensed.
