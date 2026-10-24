// Copies the open-licensed (SIL OFL) book fonts out of node_modules so the
// browser can fetch them when it typesets the PDF.
import { cpSync, mkdirSync, existsSync } from 'node:fs';

const out = 'public/fonts';
mkdirSync(out, { recursive: true });

const files = [
  ['eb-garamond', 'EBGaramond_400Regular'],
  ['eb-garamond', 'EBGaramond_400Regular_Italic'],
  ['eb-garamond', 'EBGaramond_700Bold'],
  ['cormorant-garamond', 'CormorantGaramond_500Medium'],
  ['cormorant-garamond', 'CormorantGaramond_600SemiBold'],
  ['cormorant-garamond', 'CormorantGaramond_500Medium_Italic'],
];

for (const [pkg, name] of files) {
  const dir = name.split('_').slice(1).join('_');
  const src = `node_modules/@expo-google-fonts/${pkg}/${dir}/${name}.ttf`;
  if (!existsSync(src)) throw new Error(`Missing font: ${src}`);
  cpSync(src, `${out}/${name}.ttf`);
}
console.log(`Copied ${files.length} fonts to ${out}`);
