"""Hybrid retrieval and reranking for the matching lab. Offline, CPU only, frozen inputs.

Inputs (all produced earlier, none changed here):
  views-det.jsonl         job retrieval views (deterministic JIR)  -- or an AI-JIR views file
  emb dir                 bge-small embeddings of the job views (same order as views)
  cand/<B>.json           candidate record, frozen intent, arm A, per-job structured signals (same order)
Writes one JSON per run with every arm's top five, next 35 and the retrieval pool, plus timings.

  python3 -I lab/py/retrieve.py --arch DIR --out results.json [--rerank bge-reranker-base|ms-marco-MiniLM-L-6-v2] [--shortlist 50]
"""
import argparse, json, math, os, re, sys, time
from collections import Counter, defaultdict
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from embed import Encoder  # noqa: E402
import onnxruntime as ort
from tokenizers import Tokenizer

TOK = re.compile(r"[a-z0-9+#.&/]+")
STOP = set("a an and or the of to in for on with at by from as is are be will you your we our this that it its their they who what which have has can may must should within across into per via etc also other such more than".split())
def toks(s):
    return [t.strip(".") for t in TOK.findall((s or "").lower()) if t.strip(".") and t not in STOP and len(t) > 1]

class BM25:
    def __init__(self, docs, k1=1.2, b=0.75):
        self.k1, self.b = k1, b; self.N = len(docs); self.len = np.array([len(d) for d in docs], float); self.avg = self.len.mean() or 1
        self.post = defaultdict(list)
        for i, d in enumerate(docs):
            for t, c in Counter(d).items(): self.post[t].append((i, c))
        self.idf = {t: math.log(1 + (self.N - len(p) + 0.5) / (len(p) + 0.5)) for t, p in self.post.items()}
    def score(self, q):
        s = np.zeros(self.N)
        for t in set(q):
            if t not in self.post: continue
            idf = self.idf[t]
            for i, c in self.post[t]: s[i] += idf * c * (self.k1 + 1) / (c + self.k1 * (1 - self.b + self.b * self.len[i] / self.avg))
        return s

class CrossEncoder:
    def __init__(self, root, name, maxlen=384, threads=2):
        d = os.path.join(root, "Xenova_" + name)
        self.tok = Tokenizer.from_file(os.path.join(d, "tokenizer.json")); self.tok.enable_truncation(maxlen); self.tok.enable_padding(pad_id=self.tok.token_to_id("<pad>") or 0)
        so = ort.SessionOptions(); so.intra_op_num_threads = threads
        self.sess = ort.InferenceSession(os.path.join(d, "model_quantized.onnx"), so, providers=["CPUExecutionProvider"]); self.inputs = {i.name for i in self.sess.get_inputs()}
    def score(self, query, docs, batch=8):
        out = []
        for i in range(0, len(docs), batch):
            enc = self.tok.encode_batch([(query, d) for d in docs[i:i + batch]])
            ids = np.array([e.ids for e in enc], np.int64); mask = np.array([e.attention_mask for e in enc], np.int64)
            feed = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in self.inputs: feed["token_type_ids"] = np.array([e.type_ids for e in enc], np.int64)
            out.extend(self.sess.run(None, feed)[0][:, 0].tolist())
        return np.array(out)

def rrf(rank_lists, k=60):
    s = defaultdict(float)
    for rl in rank_lists:
        for r, i in enumerate(rl): s[i] += 1.0 / (k + r + 1)
    return sorted(s, key=lambda i: -s[i]), s

def diverse(order, jobs, keep=40, per=1):
    seen, emp, out = set(), Counter(), []
    for i in order:
        e = (jobs[i]["employer"] or "").lower(); k = e + "|" + (jobs[i]["title"] or "").lower()
        if k in seen: continue
        seen.add(k)
        if len(out) < 5 and emp[e] >= per: continue
        emp[e] += 1; out.append(i)
        if len(out) >= keep: break
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", required=True); ap.add_argument("--views", default="views-det.jsonl"); ap.add_argument("--emb", default="emb-full")
    ap.add_argument("--cand", default="cand"); ap.add_argument("--out", required=True)
    ap.add_argument("--rerank", default=""); ap.add_argument("--shortlist", type=int, default=50); ap.add_argument("--pool", type=int, default=200)
    ap.add_argument("--only", default="", help="comma list of job ids to restrict the inventory to (sub-inventory experiments)")
    ap.add_argument("--models", default="/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad/models")
    a = ap.parse_args(); A = a.arch
    t0 = time.time()
    jobs = [json.loads(l) for l in open(os.path.join(A, a.views)) if l.strip()]
    ids = json.load(open(os.path.join(A, a.emb, "ids.json"))); assert ids == [j["id"] for j in jobs], "embedding order differs from views"
    E = {f: np.load(os.path.join(A, a.emb, f"bge-small-{f}-256.npy")).astype(np.float32) for f in ["resp", "skills", "whole", "whole_raw"]}
    bm = BM25([toks(j["resp"] + " " + j["skills"]) for j in jobs])
    bm_full = BM25([toks(j["whole_raw"]) for j in jobs])            # fallback channel: the posting's own full text, title included
    bm_title = BM25([toks(j["title"]) for j in jobs])               # fallback channel: the original title
    load_s = time.time() - t0
    only = set(a.only.split(",")) if a.only else None
    enc = Encoder(a.models, "bge-small", 256)
    ce = CrossEncoder(a.models, a.rerank) if a.rerank else None
    cands = sorted(f[:-5] for f in os.listdir(os.path.join(A, a.cand)) if re.match(r"B\d\d\.json", f))
    results = {"config": vars(a), "load_seconds": round(load_s, 1), "runs": []}
    for c in cands:
        C = json.load(open(os.path.join(A, a.cand, c + ".json"))); sig = np.array(C["sig"], float)
        assert len(sig) == len(jobs)
        t = {}; t1 = time.time()
        v = C["cir"]["views"]
        q = enc.encode([v["experience"] or v["skills"], v["skills"] or v["experience"], v["intent"] or v["experience"]], query=True).astype(np.float32)
        t["embed_query_ms"] = round(1000 * (time.time() - t1))
        t2 = time.time()
        elig = sig[:, 0] == 1
        if only is not None: elig &= np.array([j["id"] in only for j in jobs])
        # never two levels away; everything else is a score, not a gate
        elig &= sig[:, 2] > 0
        cand_idx = np.where(elig)[0]
        ch = {
            "dense_exp_resp": E["resp"] @ q[0], "dense_intent_resp": E["resp"] @ q[2], "dense_skill_skills": E["skills"] @ q[1],
            "dense_single": E["whole_raw"] @ q[0],
            "bm25": bm.score(toks(v["experience"] + " " + v["skills"] + " " + v["intent"])),
            "struct": sig[:, 1] * sig[:, 2] + 0.05 * sig[:, 4] + 0.3 * sig[:, 3],
            "fallback_fulltext": bm_full.score(toks(v["experience"] + " " + v["skills"])),
            "fallback_title": bm_title.score(toks(" ".join(x["title"] for x in C["cir"]["done"]["jobs"][:3]) + " " + v["intent"])),
        }
        rank_of = {k: [int(i) for i in cand_idx[np.argsort(-s[cand_idx])]] for k, s in ch.items()}
        t["channels_ms"] = round(1000 * (time.time() - t2))
        arms = {}
        def keep(name, order):
            d = diverse(order, jobs)
            arms[name] = {"top": [jobs[i]["id"] for i in d[:5]], "next": [jobs[i]["id"] for i in d[5:40]]}
        keep("B_single_vector", rank_of["dense_single"])
        keep("B_dense_multi", rrf([rank_of["dense_exp_resp"], rank_of["dense_intent_resp"], rank_of["dense_skill_skills"]])[0])
        keep("B_sparse_struct", rrf([rank_of["bm25"], rank_of["struct"]])[0])
        hyb, hs = rrf([rank_of["dense_exp_resp"], rank_of["dense_intent_resp"], rank_of["dense_skill_skills"], rank_of["bm25"], rank_of["struct"]])
        keep("B_hybrid", hyb)
        pool = hyb[: a.pool]
        results_c = {"p": c, "pool": [jobs[i]["id"] for i in pool], "eligible": int(elig.sum()), "arms": arms, "ms": t,
                     "channels": {k: [jobs[i]["id"] for i in r[:200]] for k, r in rank_of.items()}, "fused_score": {jobs[i]["id"]: round(hs[i], 6) for i in pool}}
        if ce:
            t3 = time.time(); sl = pool[: a.shortlist]
            query = (v["intent"] + ". " + v["experience"])[:1500]
            sc = ce.score(query, [(jobs[i]["title"] + ". " + jobs[i]["resp"] + ". " + jobs[i]["skills"])[:1500] for i in sl])
            t["rerank_ms"] = round(1000 * (time.time() - t3)); t["rerank_n"] = len(sl)
            ce_order = [sl[i] for i in np.argsort(-sc)]
            keep("C_rerank", ce_order)
            keep("C_rerank_fused", rrf([ce_order, sl])[0])
            results_c["ce_scores"] = {jobs[sl[i]]["id"]: round(float(sc[i]), 3) for i in range(len(sl))}
        t["total_ms"] = round(1000 * (time.time() - t1))
        results["runs"].append(results_c)
        print(json.dumps({"p": c, "eligible": int(elig.sum()), **t}), flush=True)
    json.dump(results, open(a.out, "w"), indent=1)
