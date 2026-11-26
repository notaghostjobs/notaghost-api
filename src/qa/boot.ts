// Imported FIRST by src/index.ts. In QA, the configuration is checked before anything else is loaded and the network
// boundary is installed before any client exists. A failed check stops the process: the server does not start.
import { QA, qaProblems } from "./guard.js";
import { installQaNetwork } from "./net.js";

if (QA) {
  const problems = qaProblems(process.env);
  if (problems.length) {
    console.error("\n[qa] REFUSING TO START — this QA configuration is not safe:\n" + problems.map((p) => `  ✗ ${p}`).join("\n") + "\n");
    process.exit(1);
  }
  console.log("[qa] configuration accepted: QA database, test-mode payments, simulated messaging, expiring access");
}
// the boundary is installed here, but net.ts only reads the database through the client, which is created after this
installQaNetwork();
