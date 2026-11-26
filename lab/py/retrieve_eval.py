"""Runs the frozen hybrid retrieval (retrieve.py, unchanged) for an evaluation root whose candidates are not named
Bnn. retrieve.py selects candidate files by the pattern B\\d\\d.json; this wrapper substitutes one pattern given on
the command line, checks that exactly one substitution happened, and otherwise executes retrieve.py's own code.

  python3 -I lab/py/retrieve_eval.py --cand-pattern '[A-Z]\\d{2,3}' -- <retrieve.py arguments>
"""
import os, sys, hashlib
here = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, here)
src_path = os.path.join(here, "retrieve.py"); src = open(src_path).read()
i = sys.argv.index("--"); pat = sys.argv[sys.argv.index("--cand-pattern") + 1]
old = 're.match(r"B\\d\\d\\.json", f)'
assert src.count(old) == 1, "retrieve.py changed: candidate pattern not found exactly once"
new_src = src.replace(old, "re.fullmatch(%r, f[:-5]) and f.endswith('.json')" % pat)
sys.stderr.write("retrieve.py sha256 %s, candidate pattern %s\n" % (hashlib.sha256(src.encode()).hexdigest()[:16], pat))
sys.argv = [src_path] + sys.argv[i + 1:]
exec(compile(new_src, src_path, "exec"), {"__name__": "__main__", "__file__": src_path})
