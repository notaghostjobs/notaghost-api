// Command line for one evaluation root. Every command verifies the frozen configuration first (except init and
// freeze). Paid execution is impossible in this commit: AUTHORISED (pipeline.ts) is empty.
//   tsx src/lab/v3/eval/cli.mts <command> --root DIR --population synthetic|pilot|main [options]
//   init --id ID | dev-sketches --profiles FILE --out FILE | preflight --dev-sketches FILE | select --n 5
//   snapshot --file FILE --captured-at ISO --source TEXT | prepare | run --mode dry|mock|paid [--stage S] [--first] [--resume]
//   review | report | finalise --stage S | freeze-config --note TEXT | verify
import { readFileSync, existsSync, readdirSync } from "node:fs";
const R = await import("./root.js"); const PL = await import("./pipeline.js"); const FZ = await import("./freeze.js"); const RV = await import("./review.js"); const IN = await import("./intake.js"); const MK = await import("./mock.js");
const args = process.argv.slice(2); const cmd = args[0]; const opt = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; }; const flag = (k: string) => args.includes(`--${k}`);
const MODELS = opt("models", process.env.LAB_MODELS ?? "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad/models")!;
const pop = opt("population") as any; const dir = opt("root", process.env.V3_EVAL_ROOT);
const out = (x: any) => console.log(JSON.stringify(x, null, 1));
if (cmd === "init") out(R.EvalRoot.create(dir!, pop, opt("id")!).meta);
else if (cmd === "dev-sketches") out({ profiles: PL.writeDevSketches(opt("profiles")!, opt("out")!) });
else if (cmd === "freeze-config") out(FZ.writeConfigFreeze(MODELS, opt("note", "")!));
else if (cmd === "verify") out(FZ.verifyConfig(MODELS));
else {
  const root = R.EvalRoot.open(dir, pop);
  if (cmd !== "report") FZ.verifyConfig(MODELS);
  if (cmd === "preflight") out(PL.preflightStage(root, opt("dev-sketches")!));
  else if (cmd === "select") { if (readdirSync(root.p("v3")).length) throw new Error("V3 outputs already exist: selection must precede any output");
    const pre = root.read("intake", "preflight.json"); const acc = pre.decisions.filter((d: any) => d.status === "accepted").map((d: any) => d.candidate);
    const intakes = root.candidates().map((c) => { try { return root.read("intake", c, "intake.json"); } catch { return null; } }).filter(Boolean);
    const sel = IN.selectByArrival(intakes as any, acc, Number(opt("n", "5"))); root.write("intake/sampling-manifest.json", sel); out(sel); }
  else if (cmd === "snapshot") out(PL.snapshotStage(root, opt("file")!, { captured_at: opt("captured-at")!, source: opt("source", "unspecified")! }));
  else if (cmd === "prepare") out(PL.prepareStage(root, MODELS));
  else if (cmd === "run") { const mode = opt("mode", "dry") as any; const faults = opt("faults") ? JSON.parse(readFileSync(opt("faults")!, "utf8")) : {};
    out(await PL.v3Stage(root, { mode, modelsDir: MODELS, stage: opt("stage"), key: mode === "paid" ? (process.env.GHOSTED_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || "") : undefined, fetchImpl: mode === "mock" ? MK.mockFetch({ faults }) : undefined, onlyFirst: flag("first"), resume: flag("resume") })); }
  else if (cmd === "review") out(RV.reviewStage(root).counts);
  else if (cmd === "report") out(PL.reportStage(root));
  else if (cmd === "finalise") { const pc = root.p("manifest", "pricing-check.json"); if (!existsSync(pc)) throw new Error("record the pricing check first: manifest/pricing-check.json"); out(FZ.finalise(root, MODELS, { stage: opt("stage")!, pricing: JSON.parse(readFileSync(pc, "utf8")) })); }
  else throw new Error(`unknown command ${cmd}`);
}
