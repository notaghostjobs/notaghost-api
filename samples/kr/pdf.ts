import { readFileSync, writeFileSync } from "node:fs";
import { resumePdf } from "../../src/engine/pdf.js";
const d = JSON.parse(readFileSync("samples/kr/out.json", "utf8"));
writeFileSync("samples/kr/out.pdf", await resumePdf(d.rewrite, d.profile)); process.exit(0);
