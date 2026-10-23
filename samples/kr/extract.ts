import { readFileSync, writeFileSync } from "node:fs";
import { extractText } from "../../src/engine/extract.js";
const r = await extractText(readFileSync("samples/kr/resume.pdf"), "resume.pdf");
writeFileSync("samples/kr/text.txt", r.text);
console.log(r.pages, r.text.length); console.log(r.text.slice(0, 1500));
