"""Local embeddings for the matching lab, CPU only, quantized ONNX models from Hugging Face (Xenova exports).
No network at run time; models are read from a local folder. Writes float16 matrices (.npy) and an id list.

  python3 lab/py/embed.py --model bge-small --views views-det.jsonl --fields resp,skills --out DIR [--limit N] [--maxlen 256]
"""
import argparse, json, os, sys, time
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODELS = {
    # name: (folder, pooling, passage prefix, query prefix)
    "bge-small": ("Xenova_bge-small-en-v1.5", "cls", "", "Represent this sentence for searching relevant passages: "),
    "bge-base": ("Xenova_bge-base-en-v1.5", "cls", "", "Represent this sentence for searching relevant passages: "),
    "e5-small": ("Xenova_e5-small-v2", "mean", "passage: ", "query: "),
}


class Encoder:
    def __init__(self, root, name, maxlen=256, threads=2):
        folder, self.pool, self.pp, self.qp = MODELS[name]
        d = os.path.join(root, folder)
        self.tok = Tokenizer.from_file(os.path.join(d, "tokenizer.json"))
        self.tok.enable_truncation(maxlen)
        self.tok.enable_padding(pad_id=0, pad_token="[PAD]")
        so = ort.SessionOptions(); so.intra_op_num_threads = threads; so.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(os.path.join(d, "model_quantized.onnx"), so, providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.sess.get_inputs()}

    def encode(self, texts, query=False, batch=32):
        # batches of similar length, so padding costs little; the result is put back in the input order
        order = sorted(range(len(texts)), key=lambda i: len(texts[i] or ""))
        res = self._encode([texts[i] for i in order], query, batch)
        back = np.empty_like(res); back[order] = res
        return back

    def _encode(self, texts, query, batch):
        out = []
        pre = self.qp if query else self.pp
        for i in range(0, len(texts), batch):
            enc = self.tok.encode_batch([pre + (t or " ") for t in texts[i:i + batch]])
            ids = np.array([e.ids for e in enc], dtype=np.int64); mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
            feed = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in self.inputs: feed["token_type_ids"] = np.zeros_like(ids)
            h = self.sess.run(None, feed)[0]
            v = h[:, 0] if self.pool == "cls" else (h * mask[..., None]).sum(1) / np.maximum(mask.sum(1, keepdims=True), 1)
            v = v / np.linalg.norm(v, axis=1, keepdims=True)
            out.append(v.astype(np.float16))
        return np.concatenate(out) if out else np.zeros((0, 384), np.float16)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True); ap.add_argument("--views", required=True); ap.add_argument("--fields", required=True)
    ap.add_argument("--out", required=True); ap.add_argument("--limit", type=int, default=0); ap.add_argument("--maxlen", type=int, default=256)
    ap.add_argument("--models", default=os.environ.get("LAB_MODELS", "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad/models"))
    a = ap.parse_args()
    rows = [json.loads(l) for l in open(a.views) if l.strip()]
    if a.limit: rows = rows[: a.limit]
    enc = Encoder(a.models, a.model, a.maxlen)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "ids.json"), "w") as f: json.dump([r["id"] for r in rows], f)
    for field in a.fields.split(","):
        t0 = time.time(); m = enc.encode([r.get(field, "") for r in rows]); dt = time.time() - t0
        np.save(os.path.join(a.out, f"{a.model}-{field}-{a.maxlen}.npy"), m)
        print(json.dumps({"model": a.model, "field": field, "n": len(rows), "maxlen": a.maxlen, "seconds": round(dt, 1), "per_text_ms": round(1000 * dt / max(1, len(rows)), 2)}), flush=True)
