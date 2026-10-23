import { readFileSync, writeFileSync } from "node:fs";
import { resumePdf } from "../src/engine/pdf.js";
const d = JSON.parse(readFileSync("samples/out1.json", "utf8"));
writeFileSync("samples/out1.pdf", await resumePdf(d.rewrite, d.profile));
