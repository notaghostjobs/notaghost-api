// Runs one real Scout order from the command line (uses the web-search key in the environment). Not part of any gate.
import { scout } from "../routes/scout.js";
const [role, location, ymin, ymax, must] = process.argv.slice(2);
const r = await scout({ role: role ?? "Finance Manager", location: location ?? "Austin, TX", years_min: ymin ? Number(ymin) : null, years_max: ymax ? Number(ymax) : null, must: must ?? "" });
console.log(JSON.stringify(r, null, 1));
