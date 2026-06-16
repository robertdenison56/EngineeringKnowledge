#!/usr/bin/env node
/**
 * Generates the PDF sample fixtures deterministically — no PDF library, so
 * the fixtures stay reproducible and reviewable. Two corpus classes from the
 * OQ 8 spike:
 *
 *  - a born-digital spec excerpt WITH a text layer (extraction should work)
 *  - an image-only "scanned" drawing sheet WITHOUT one (extraction should
 *    honestly report needs-OCR, never garbage text)
 *
 * Run: node scripts/make-sample-pdfs.mjs   (from services/ingestion)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');
mkdirSync(samplesDir, { recursive: true });

/** Assemble a valid PDF from 1-indexed object bodies, computing the xref. */
function buildPdf(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const obj = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    chunks.push(obj);
    offset += obj.length;
  });
  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

function stream(dict, body) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

// --- Fixture 1: born-digital spec excerpt with a text layer ----------------

const specLines = [
  'SECTION 07 92 00 - JOINT SEALANTS',
  '',
  'PART 2 - PRODUCTS',
  '2.1 SILICONE SEALANT',
  '  A. Single-component neutral-cure silicone: ASTM C920, Type S,',
  '     Grade NS, Class 50, for exterior curtain wall perimeter joints.',
  '  B. Backer rod: closed-cell polyethylene, diameter approximately',
  '     25 percent greater than joint width.',
  '',
  'PART 3 - EXECUTION',
  '3.1 INSTALLATION',
  '  A. Tool joints to a concave profile. Do not use soap or oil as a',
  '     tooling agent.',
  '  B. Movement joints at curtain wall perimeter: 1/2 inch minimum',
  '     width; verify joint dimensions before sealant application.',
];
const specContent =
  'BT\n/F1 11 Tf\n14 TL\n72 720 Td\n' +
  specLines.map((l) => `(${esc(l)}) Tj\nT*`).join('\n') +
  '\nET';

const specPdf = buildPdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  stream('', specContent),
]);

// --- Fixture 2: image-only scanned drawing sheet (no text layer) -----------

const W = 16;
const pixels = Buffer.alloc(W * W);
for (let y = 0; y < W; y++)
  for (let x = 0; x < W; x++) pixels[y * W + x] = (x * 16 + y * 3) % 256;

const scanPdf = buildPdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
  stream(
    `/Type /XObject /Subtype /Image /Width ${W} /Height ${W} /ColorSpace /DeviceGray /BitsPerComponent 8`,
    pixels,
  ),
  stream('', 'q\n612 0 0 792 0 0 cm\n/Im0 Do\nQ'),
]);

// --- Fixture 3: vector drawing sheet WITH OCG layers (CAD-native parsing) --

/**
 * Hand-authored optional content groups simulate a CAD export that kept its
 * layer table (vector-parsing plan, tier 2): dimension text + a dimension
 * line on S-ANNO-DIMS, the border + title block on border_SHEET. Geometry
 * uses known coordinates so decoder tests can assert exact page positions.
 * Notes are drawn in REVERSE order (2 before 1) to exercise reading-order
 * reconstruction, mirroring real draw-order scramble (ADR 0004).
 */
const layeredContent =
  '/OC /OC1 BDC\n' +
  'BT\n/F1 10 Tf\n100 388 Td\n(3\'-6") Tj\nET\n' +
  '2 w\n0 0 1 RG\n72 380 m\n200 380 l\nS\n' +
  'EMC\n' +
  '/OC /OC2 BDC\n' +
  '1 w\n0 0 0 RG\n36 36 540 60 re\nS\n' +
  'BT\n/F1 8 Tf\n' +
  '60 64 Td\n(DEMO STANDARD PLANS) Tj\n' +
  '200 0 Td\n(WIDGET WALL DETAILS) Tj\n' +
  '180 12 Td\n(INDEX) Tj\n0 -12 Td\n(650-010) Tj\n' +
  '60 12 Td\n(SHEET) Tj\n0 -12 Td\n(2 of 7) Tj\n' +
  '-440 -8 Td\n(LAST REVISION 11/01/21) Tj\n' +
  'ET\nEMC\n' +
  // Notes drawn out of order: "2." first, then "1." — reading order must fix.
  'BT\n/F1 9 Tf\n72 690 Td\n(2. Second general note about anchors.) Tj\nET\n' +
  'BT\n/F1 9 Tf\n72 704 Td\n(1. First general note about concrete.) Tj\nET\n' +
  'BT\n/F1 9 Tf\n72 730 Td\n(GENERAL NOTES:) Tj\nET';

const layeredPdf = buildPdf([
  '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R 7 0 R] /D << /Order [6 0 R 7 0 R] /ON [6 0 R 7 0 R] >> >> >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> /Properties << /OC1 6 0 R /OC2 7 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  stream('', layeredContent),
  '<< /Type /OCG /Name (S-ANNO-DIMS) >>',
  '<< /Type /OCG /Name (border_SHEET) >>',
]);

// --- Fixture 4: drawing sheet with Phase B semantics at known coordinates --

/**
 * Exercises every Phase B detector (semantics.ts) deterministically:
 *  - callout bubble: a 4-Bézier circle (center 300,500 r=18) with divider,
 *    detail "3" over sheet "S-101" → cross-sheet reference
 *  - match line: long dashed stroke at y=300 + "MATCH LINE - SEE SHEET C-103"
 *  - dimension 12'-6" riding a dimension line (y=452) inside a SECTION A-A
 *    view cluster, scale noted below the label
 *  - schedule: 4×3 rule grid (x 380-560, y 600-660) with a 3-row text matrix
 *    under a "PIPE SCHEDULE" heading
 *  - title block: sheet C-102, 5 of 12, last revision 03/15/24
 * No OCG layers — everything must come from geometry and patterns (Tier 1).
 */
const K = 9.94; // 18pt-radius circle Bézier handle (r × 0.5523)
const calloutContent =
  // Callout bubble with divider and 3/S-101 stack.
  '1 w\n0 0 0 RG\n' +
  '318 500 m\n' +
  `318 ${500 + K} ${300 + K} 518 300 518 c\n` +
  `${300 - K} 518 282 ${500 + K} 282 500 c\n` +
  `282 ${500 - K} ${300 - K} 482 300 482 c\n` +
  `${300 + K} 482 318 ${500 - K} 318 500 c\n` +
  'h\nS\n' +
  '282 500 m\n318 500 l\nS\n' +
  'BT\n/F1 9 Tf\n297 504 Td\n(3) Tj\nET\n' +
  'BT\n/F1 7 Tf\n288 489 Td\n(S-101) Tj\nET\n' +
  // SECTION A-A view: wall outline + dimension line above the label.
  '80 440 m\n220 440 l\nS\n' +
  '80 470 m\n220 470 l\nS\n' +
  '80 440 m\n80 470 l\nS\n' +
  '220 440 m\n220 470 l\nS\n' +
  '80 452 m\n220 452 l\nS\n' +
  `BT\n/F1 8 Tf\n130 455 Td\n(12'-6") Tj\nET\n` +
  'BT\n/F1 9 Tf\n90 430 Td\n(SECTION A-A) Tj\nET\n' +
  `BT\n/F1 7 Tf\n92 416 Td\n(1/2" = 1'-0") Tj\nET\n` +
  // Match line: long dashed stroke with the label beside it.
  '[6 3] 0 d\n60 300 m\n560 300 l\nS\n[] 0 d\n' +
  'BT\n/F1 8 Tf\n200 306 Td\n(MATCH LINE - SEE SHEET C-103) Tj\nET\n' +
  // Pipe schedule: 4 horizontal + 3 vertical rules, 3×2 text matrix.
  '380 600 m\n560 600 l\nS\n380 620 m\n560 620 l\nS\n' +
  '380 640 m\n560 640 l\nS\n380 660 m\n560 660 l\nS\n' +
  '380 600 m\n380 660 l\nS\n460 600 m\n460 660 l\nS\n560 600 m\n560 660 l\nS\n' +
  'BT\n/F1 8 Tf\n380 666 Td\n(PIPE SCHEDULE) Tj\nET\n' +
  'BT\n/F1 8 Tf\n390 646 Td\n(MARK) Tj\nET\nBT\n/F1 8 Tf\n470 646 Td\n(SIZE) Tj\nET\n' +
  'BT\n/F1 8 Tf\n390 626 Td\n(P-1) Tj\nET\nBT\n/F1 8 Tf\n470 626 Td\n(18" RCP) Tj\nET\n' +
  'BT\n/F1 8 Tf\n390 606 Td\n(P-2) Tj\nET\nBT\n/F1 8 Tf\n470 606 Td\n(24" RCP) Tj\nET\n' +
  // Title block.
  '36 36 540 60 re\nS\n' +
  'BT\n/F1 8 Tf\n' +
  '60 64 Td\n(DEMO STANDARD PLANS) Tj\n' +
  '180 0 Td\n(DRAINAGE PLAN AND DETAILS) Tj\n' +
  '200 12 Td\n(INDEX) Tj\n0 -12 Td\n(C-102) Tj\n' +
  '60 12 Td\n(SHEET) Tj\n0 -12 Td\n(5 of 12) Tj\n' +
  '-440 -8 Td\n(LAST REVISION 03/15/24) Tj\n' +
  'ET';

const calloutPdf = buildPdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  stream('', calloutContent),
]);

writeFileSync(join(samplesDir, '07 92 00 - Joint Sealants Spec (excerpt).pdf'), specPdf);
writeFileSync(join(samplesDir, 'A-501 Curtain Wall Details (scanned).pdf'), scanPdf);
writeFileSync(join(samplesDir, 'S-101 Widget Wall Details (layered).pdf'), layeredPdf);
writeFileSync(join(samplesDir, 'C-102 Drainage Plan (callouts).pdf'), calloutPdf);
console.log('Wrote 4 PDF fixtures to', samplesDir);
