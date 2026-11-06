// Builds scripts/samples/vlookup-motion.json: the VLOOKUP plate plus a four-scene motion sequence.
// It is the reference for what a motion sequence should feel like; preview it with
//   BUDDY_EXPLAINER_TEST=scripts/samples/vlookup-motion.json npm start
const fs = require("fs");
const path = require("path");

const base = require("./samples/vlookup.json");
const EASE = 'calcMode="spline" keyTimes="0;1" keySplines="0.2 0.8 0.2 1" fill="freeze"';
const fadeIn = (begin, dur = 0.4) => `<animate attributeName="opacity" from="0" to="1" begin="${begin}s" dur="${dur}s" ${EASE}/>`;
const fadeOut = (begin, dur = 0.3) => `<animate attributeName="opacity" from="1" to="0" begin="${begin}s" dur="${dur}s" ${EASE}/>`;
const move = (from, to, begin, dur) =>
  `<animateTransform attributeName="transform" type="translate" from="${from}" to="${to}" begin="${begin}s" dur="${dur}s" ${EASE}/>`;

const formula = `<text x="300" y="66" text-anchor="middle" class="name" style="font-size:20px">=VLOOKUP(<tspan class="p3">A2</tspan>, Prices!A:C, 3, FALSE)</text>`;
const rows = [
  ["Apple", "Large", "$0.90", 194],
  ["Pear", "Small", "$1.20", 223],
  ["Plum", "Small", "$1.50", 252],
  ["Fig", "Medium", "$2.10", 281],
];
const table = (under = "") =>
  `<rect x="150" y="146" width="300" height="144" class="p1s"/>${under}` +
  `<rect x="150" y="146" width="300" height="28" class="plate-fill" opacity="0.55"/>` +
  `<text x="162" y="165" class="small">Item</text><text x="262" y="165" class="small">Size</text><text x="362" y="165" class="small">Price</text>` +
  `<path d="M150 174 H450 M150 203 H450 M150 232 H450 M150 261 H450 M250 146 V290 M350 146 V290" class="leader"/>` +
  `<rect x="150" y="146" width="300" height="144" class="outline"/>` +
  rows.map(([a, b, c, y]) => `<text x="162" y="${y}" class="num">${a}</text><text x="262" y="${y}" class="num">${b}</text><text x="362" y="${y}" class="num">${c}</text>`).join("");
const chip = (text, cls, inner = "") =>
  `<rect x="-34" y="-15" width="68" height="30" rx="15" class="${cls}"/><text x="0" y="6" text-anchor="middle" class="name">${text}</text>${inner}`;

// 1. The value leaves the formula and goes to the table.
const scene1 = `<svg viewBox="0 0 600 340">${formula}${table()}
<g transform="translate(216 92)" opacity="0">${fadeIn(0.8)}${move("216 92", "90 189", 1.5, 1.3)}${chip("Pear", "p3s")}</g>
<text x="24" y="316" class="label-2" opacity="0">${fadeIn(2.9)}A2 holds the value to find</text></svg>`;

// 2. It walks down the first column only, row by row, until it matches.
const scene2 = `<svg viewBox="0 0 600 340">${formula}${table(
  `<rect x="150" y="174" width="100" height="29" class="p3s" opacity="0">${fadeIn(0.6)}<animate attributeName="y" from="174" to="203" begin="1.9s" dur="0.7s" ${EASE}/></rect>`,
)}
<rect x="250" y="174" width="200" height="116" class="hatch" opacity="0">${fadeIn(3.3, 0.5)}</rect>
<g transform="translate(90 189)">${move("90 189", "90 218", 1.9, 0.7)}${chip("Pear", "p3s")}</g>
<text x="137" y="196" text-anchor="middle" class="label" opacity="0">${fadeIn(1.0, 0.2)}${fadeOut(1.8, 0.2)}≠</text>
<text x="137" y="225" text-anchor="middle" class="label" opacity="0">${fadeIn(2.7, 0.2)}=</text>
<rect x="152" y="205" width="96" height="25" rx="4" class="here" opacity="0">${fadeIn(2.9, 0.3)}</rect>
<text x="460" y="316" text-anchor="end" class="label-2" opacity="0">${fadeIn(3.5)}the other columns are never searched</text></svg>`;

// 3. Push in on the matching row; count across to column 3.
const cols = [200, 300, 400].map((x, k) => `<text x="${x}" y="138" text-anchor="middle" class="name" opacity="0">${fadeIn(1.5 + k * 0.45, 0.25)}${k + 1}</text>`).join("");
const scene3 = `<svg viewBox="0 0 600 340"><animate attributeName="viewBox" from="0 0 600 340" to="40 96 452 256" begin="0.4s" dur="1.3s" ${EASE}/>
${formula}${table(
  // The count: a cell-sized wash hops along the row in step with the column numbers above it.
  `<rect x="150" y="204" width="100" height="27" class="p2s" opacity="0">${fadeIn(1.5, 0.2)}<animate attributeName="x" values="150;250;350" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.2 0.8 0.2 1;0.2 0.8 0.2 1" begin="1.5s" dur="0.9s" fill="freeze"/></rect>`,
)}<rect x="150" y="203" width="300" height="29" class="outline" style="stroke-width:2.4"/>
<g transform="translate(90 218)">${chip("Pear", "p3s")}</g>${cols}
<rect x="352" y="205" width="96" height="25" rx="4" class="here" opacity="0">${fadeIn(2.6, 0.3)}</rect></svg>`;

// 4. Pull back; the answer lifts out of the row and lands in your cell.
const scene4 = `<svg viewBox="40 96 452 256"><animate attributeName="viewBox" from="40 96 452 256" to="0 0 600 340" begin="0.2s" dur="1.2s" ${EASE}/>
${formula}${table()}<rect x="150" y="203" width="300" height="29" class="outline" style="stroke-width:2.4"/>
<g transform="translate(90 218)">${chip("Pear", "p3s")}</g>
<text x="470" y="104" class="small">B2</text><rect x="470" y="110" width="100" height="34" rx="4" class="outline"/>
<g transform="translate(400 218)" opacity="0">${fadeIn(1.2, 0.3)}${move("400 218", "520 127", 1.7, 1.2)}${chip("$1.20", "p2s")}</g>
<text x="576" y="176" text-anchor="end" class="label" opacity="0">${fadeIn(3.0)}your cell</text></svg>`;

const sample = {
  ...base,
  motion: {
    scenes: [
      { svg: scene1, narration: "VLOOKUP lifts the value out of A2 and carries it to the table.", seconds: 4.5 },
      { svg: scene2, narration: "It walks down the first column only, until a row matches exactly.", seconds: 5.5 },
      { svg: scene3, narration: "On the matching row it counts across to column 3.", seconds: 4.5 },
      { svg: scene4, narration: "Whatever sits there is handed back to your cell.", seconds: 4.5 },
    ],
  },
};
fs.writeFileSync(path.join(__dirname, "samples", "vlookup-motion.json"), JSON.stringify(sample, null, 2));
console.log("wrote samples/vlookup-motion.json");
