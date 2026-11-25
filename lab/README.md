# Matching lab (offline, 25 Nov 2026)

Nothing here is wired to a route or writes to a database. Data (snapshot, records, embeddings, labels, results) is kept
outside Git in the workspace; résumés are never committed.

Reproduce, in order (paths: S = workspace scratchpad):
1. `npx tsx src/lab/build-jir.mts S/bench/prod/inventory.jsonl S/arch` — deterministic job records + retrieval views (23,690).
2. `python3 -I lab/py/embed.py --model bge-small --views S/arch/views-det.jsonl --fields resp,skills,whole,whole_raw --out S/arch/emb-full` — local embeddings (models: Xenova ONNX int8 exports, Hugging Face).
3. `npx tsx src/lab/prep-cands.mts S/bench/profiles-19-local.json S/sim2/answers.json S/bench/prod/inventory.jsonl S/arch/jir-det.jsonl S/arch/cand` — candidate records (simulated intent, frozen sha 022105e8…), arm A.
4. `python3 -I lab/py/retrieve.py --arch S/arch --out S/arch/runs/full-B.json [--rerank bge-reranker-base|ms-marco-MiniLM-L-6-v2 --shortlist 50]` — arms B and C.
5. AI pilot: `BENCH_PROXY=… BENCH_TOKEN_FILE=… npx tsx lab/pilot/run.mts <model> <partition> S/pilot` (QA pass-through, ₹350 cap).
6. Isolation: `npx tsx src/lab/build-sub.mts S/pilot/ai-claude-haiku-5-5-<pv>.jsonl S/arch/sub`, embed both views, run retrieve.py on each.
7. Grading: `lab/eval/mk-pairs-full.py`, `lab/eval/mk-pack.mts`, blind graders with `lab/eval/rubric.md`; score with `lab/eval/score-arch.py`; job tags with `lab/eval/ai-score.mts`.
