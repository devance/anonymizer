// Pixel comparison of two folders of screenshots (desktop/e2e/headless.mjs, web/e2e/run.mjs --shots),
// decoded in headless Chromium so nothing else needs installing. For each PNG in <before>: "0" when
// every pixel matches, else how many differ and where; differing pixels are painted red over the
// "after" image in <diff-dir>.
//
//   node desktop/e2e/compare.mjs <before> <after> [diff-dir]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [a, b, d] = process.argv.slice(2);
if (!a || !b) {
  console.error('usage: node desktop/e2e/compare.mjs <before> <after> [diff-dir]');
  process.exit(2);
}
if (d) mkdirSync(d, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas></canvas>');

let differ = 0;
for (const f of readdirSync(a).filter((f) => f.endsWith('.png')).sort()) {
  if (!existsSync(join(b, f))) {
    console.log(`${f}: MISSING in after`);
    differ++;
    continue;
  }
  const r = await page.evaluate(
    async ([x, y]) => {
      const load = async (b64) => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height);
        const ctx = c.getContext('2d', { colorSpaceConversion: 'none' });
        ctx.drawImage(img, 0, 0);
        return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data, c, ctx };
      };
      const A = await load(x);
      const B = await load(y);
      if (A.w !== B.w || A.h !== B.h) return { size: `${A.w}x${A.h} -> ${B.w}x${B.h}` };
      let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, md = 0;
      const out = B.ctx.getImageData(0, 0, B.w, B.h);
      for (let i = 0; i < A.data.length; i += 4) {
        const dd = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]), Math.abs(A.data[i + 3] - B.data[i + 3]));
        if (!dd) continue;
        n++;
        md = Math.max(md, dd);
        const p = i / 4, px = p % A.w, py = Math.floor(p / A.w);
        x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
        out.data.set([255, 0, 0, 255], i);
      }
      if (!n) return { n };
      B.ctx.putImageData(out, 0, 0);
      const blob = await B.c.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { n, box: `${x0},${y0} - ${x1},${y1}`, md, png: btoa(s) };
    },
    [readFileSync(join(a, f)).toString('base64'), readFileSync(join(b, f)).toString('base64')],
  );
  if (r.size) {
    console.log(`${f}: SIZE ${r.size}`);
    differ++;
  } else if (r.n) {
    console.log(`${f}: ${r.n} px differ, box ${r.box}, max delta ${r.md}`);
    if (d) writeFileSync(join(d, f), Buffer.from(r.png, 'base64'));
    differ++;
  } else console.log(`${f}: 0`);
}
await browser.close();
console.log(`${differ} files differ`);
process.exit(differ ? 1 : 0);
