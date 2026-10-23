import { readFileSync } from "node:fs";
import { render } from "../src/engine/pdf.js";
const d = JSON.parse(readFileSync("samples/out1.json", "utf8"));
for (const s of [1, 1.2, 1.4, 1.6]) console.log(s, await render(d.rewrite, d.profile, s, true));
