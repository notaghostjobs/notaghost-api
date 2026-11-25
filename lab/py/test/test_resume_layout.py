"""Parser checks for resume_layout.py on a generated two-column page with invented lines (a parser fixture, not a
résumé and never used for evaluation). Run: python3 -I lab/py/test/test_resume_layout.py"""
import os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
import resume_layout as rl

fails = 0
def ok(name, cond):
    global fails
    print(("  ✓ " if cond else "  ✗ ") + name); fails += 0 if cond else 1

d = tempfile.mkdtemp(); pdf = os.path.join(d, "fixture.pdf")
c = canvas.Canvas(pdf, pagesize=A4); W, H = A4
side = ["S K I L L S", "Kubernetes", "Terraform", "Python", "SQL", "LANGUAGES", "English"] + [f"Tool {i}" for i in range(12)]
main = ["Alex Example", "SUMMARY", "Platform engineer with eight years of experience.", "EXPERIENCE", "Senior Engineer, Fictional Corp  Jan 2021 - Present",
        "Built deployment pipelines on Kubernetes for twelve services.", "Led migration of batch jobs to Python.", "EDUCATION", "B.E. Computer Science, 2014"] + [f"Delivered item {i} for the platform team." for i in range(14)]
y = H - 60
for s in side: c.drawString(40, y, s); y -= 16
y = H - 60
for s in main: c.drawString(230, y, s); y -= 16
c.save()

r = rl.read(pdf)
ok("two columns found", r["layout"][0]["two_column"])
left = [l for l in r["lines"] if l["column"] == "left"]; right = [l for l in r["lines"] if l["column"] == "right"]
ok("sidebar lines stay in the sidebar", any(l["text"] == "Kubernetes" for l in left) and not any("Kubernetes" == l["text"] for l in right))
ok("letter-spaced heading read as skills", any(l.get("is_heading") and l["section"] == "skills" for l in left))
ok("sidebar skill under skills", next(l for l in left if l["text"] == "Terraform")["section"] == "skills")
ok("job line under experience", next(l for l in right if l["text"].startswith("Built deployment"))["section"] == "experience")
ok("summary line under summary", next(l for l in right if l["text"].startswith("Platform engineer"))["section"] == "summary")
ok("words keep their spacing", any("deployment pipelines on Kubernetes" in l["text"] for l in right))
ok("heading(): variants", rl.heading("Work History") == "experience" and rl.heading("Technical Skills:") == "skills" and rl.heading("Built a thing with many words in it") is None)
print("all passed" if not fails else f"{fails} failed"); sys.exit(1 if fails else 0)
