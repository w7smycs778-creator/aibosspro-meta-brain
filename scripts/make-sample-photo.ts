// Renders the bundled synthetic product photo for the content demo: an amber
// beard-oil bottle with a dropper cap on a wooden counter. Drawn from SVG
// shapes with sharp; no third-party images and no real photos.
// Run: npx tsx scripts/make-sample-photo.ts [out=fixtures/demo/beard-oil.jpg]
import sharp from "sharp";

const W = 1200;
const H = 1500;
const out = process.argv[2] ?? "fixtures/demo/beard-oil.jpg";

// Wood grain: thin wavy strokes across the counter.
const grain = Array.from({ length: 26 }, (_, i) => {
  const y = 1010 + i * 19 + (i % 3) * 4;
  const a = 6 + (i % 5) * 3;
  return `<path d="M0 ${y} C 300 ${y - a}, 600 ${y + a}, 900 ${y - a / 2} S 1200 ${y + a / 2}, 1200 ${y}" stroke="#7a4f2a" stroke-opacity="${0.12 + (i % 4) * 0.05}" stroke-width="${2 + (i % 3)}" fill="none"/>`;
}).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="wall" cx="50%" cy="35%" r="75%">
      <stop offset="0" stop-color="#f3ede4"/><stop offset="1" stop-color="#cfc4b4"/>
    </radialGradient>
    <linearGradient id="wood" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#b07a48"/><stop offset="1" stop-color="#8a5a32"/>
    </linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#5a2a08"/><stop offset="0.25" stop-color="#a3540f"/>
      <stop offset="0.55" stop-color="#c26a17"/><stop offset="1" stop-color="#4a2206"/>
    </linearGradient>
    <linearGradient id="cap" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#111"/><stop offset="0.4" stop-color="#3a3a3a"/><stop offset="1" stop-color="#0c0c0c"/>
    </linearGradient>
    <linearGradient id="label" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#cdb48c"/><stop offset="0.5" stop-color="#e6d2ad"/><stop offset="1" stop-color="#bfa47a"/>
    </linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="soft"><feGaussianBlur stdDeviation="3"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#wall)"/>
  <rect y="990" width="${W}" height="${H - 990}" fill="url(#wood)"/>
  ${grain}
  <rect y="985" width="${W}" height="10" fill="#5e3a1c" opacity="0.5"/>
  <ellipse cx="620" cy="1105" rx="250" ry="42" fill="#2b1a0c" opacity="0.55" filter="url(#blur)"/>
  <!-- bottle body, shoulder and neck -->
  <path d="M430 640 Q430 560 520 530 L540 470 L660 470 L680 530 Q770 560 770 640 L770 1060 Q770 1100 730 1100 L470 1100 Q430 1100 430 1060 Z" fill="url(#glass)"/>
  <rect x="535" y="430" width="130" height="50" rx="8" fill="url(#cap)"/>
  <!-- dropper bulb -->
  <path d="M555 432 L555 330 Q555 250 600 250 Q645 250 645 330 L645 432 Z" fill="url(#cap)"/>
  <path d="M575 300 Q580 270 598 268" stroke="#777" stroke-width="6" fill="none" opacity="0.6"/>
  <!-- label with a plain geometric mark, no text -->
  <rect x="450" y="700" width="300" height="270" rx="10" fill="url(#label)"/>
  <rect x="470" y="720" width="260" height="230" rx="6" fill="none" stroke="#6b4a26" stroke-width="4" opacity="0.7"/>
  <circle cx="600" cy="835" r="62" fill="none" stroke="#6b4a26" stroke-width="10" opacity="0.8"/>
  <path d="M600 795 L630 835 L600 875 L570 835 Z" fill="#6b4a26" opacity="0.8"/>
  <!-- glass highlights -->
  <rect x="470" y="600" width="26" height="440" rx="13" fill="#fff" opacity="0.28" filter="url(#soft)"/>
  <rect x="720" y="640" width="10" height="360" rx="5" fill="#fff" opacity="0.15" filter="url(#soft)"/>
</svg>`;

sharp(Buffer.from(svg))
  .jpeg({ quality: 88 })
  .toFile(out)
  .then((info) => console.log(`${out}: ${info.width}x${info.height}, ${info.size} bytes`))
  .catch((err) => {
    console.error(`make-sample-photo failed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
