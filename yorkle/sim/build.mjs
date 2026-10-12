// Inlines the engine into the page: one self-contained HTML file at sim/dist/orchard-at-scale.html.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = new URL(".", import.meta.url);
const page = readFileSync(new URL("ui.html", dir), "utf8").replace("/*ENGINE*/", () => readFileSync(new URL("engine.cjs", dir), "utf8"));
mkdirSync(new URL("dist/", dir), { recursive: true });
writeFileSync(new URL("dist/orchard-at-scale.html", dir), page);
console.log("sim/dist/orchard-at-scale.html");
