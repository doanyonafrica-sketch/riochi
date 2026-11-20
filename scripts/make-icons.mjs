// Génère les icônes et écrans de démarrage de Riochi dans resources/ (aucune police requise).
// Usage : node scripts/make-icons.mjs   puis   npx capacitor-assets generate --android --assetPath resources
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const BG = "#16132a";   // --bg
const AC = "#ff7a9c";   // --ac
const TX = "#16132a";
mkdirSync("resources", { recursive: true });

// Un « R » dessiné en traits, dans un carré rose légèrement incliné (comme les affiches de l'appli).
// size = taille du canevas, k = part de la taille occupée par le logo (1 = icône, plus petit pour l'écran de démarrage).
const mark = (size, k = 1) => { const m = size * k; return `
<g transform="translate(${size / 2} ${size / 2}) rotate(-6)">
  <rect x="-${m * 0.26}" y="-${m * 0.26}" width="${m * 0.52}" height="${m * 0.52}" rx="${m * 0.07}" fill="${AC}"/>
  <g fill="none" stroke="${TX}" stroke-width="${m * 0.065}" stroke-linecap="square" stroke-linejoin="miter" transform="translate(-${m * 0.095} -${m * 0.155})">
    <path d="M0 0 V${m * 0.31}"/>
    <path d="M0 0 H${m * 0.085} a${m * 0.075} ${m * 0.075} 0 0 1 0 ${m * 0.15} H0"/>
    <path d="M${m * 0.07} ${m * 0.15} L${m * 0.175} ${m * 0.31}" stroke-linecap="butt"/>
  </g>
</g>`; };

const svg = (size, bg, withMark = true, k = 1) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : ""}
  ${withMark ? mark(size, k) : ""}
</svg>`);

const out = (name, buf, size) => sharp(buf).resize(size, size).png().toFile(`resources/${name}`);

await Promise.all([
  out("icon-only.png", svg(1024, BG), 1024),
  out("icon-foreground.png", svg(1024, null), 1024),
  out("icon-background.png", svg(1024, BG, false), 1024),
  out("splash.png", svg(2732, BG, true, 0.4), 2732),
  out("splash-dark.png", svg(2732, BG, true, 0.4), 2732),
  out("icon.png", svg(1024, BG), 512),   // icône Windows (electron-builder la convertit en .ico)
]);
console.log("Icônes générées dans resources/");
