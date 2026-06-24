import { readFileSync, writeFileSync } from 'node:fs';
import { renderSheetImages } from '../dist/raster/render.js';

const [file, pageArg, prefix] = process.argv.slice(2);
const data = new Uint8Array(readFileSync(file));
const t0 = Date.now();
const images = await renderSheetImages(data, Number(pageArg), { overviewDpi: 130, tileDpi: 230 });
for (const img of images) {
  const name = img.label.includes('overview') ? 'overview' : `tile${img.label.match(/tile (\d)/)[1]}`;
  writeFileSync(`${prefix}-${name}.png`, img.png);
}
console.log(`rendered ${images.length} images in ${Date.now() - t0} ms`);
