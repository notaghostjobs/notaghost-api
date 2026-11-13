// The Open walk (14 Nov): the whole of Ghosted Open the way two people meet it, run by a machine after every deploy and
// nightly. An employer account verifies a company and posts a question; the candidate account (the fixed test résumé)
// is found relevant, answers, gets a follow-up, replies inside the window, is invited, accepts; the employer pays (the
// tester path) and receives the contact; the role closes and the public page says how it ended. A second question, for
// a different function, must refuse the same candidate. Everything it writes is removed at the end.
import { db } from "../lib/db.js";
import { createSession } from "../lib/auth.js";

export const OPEN_FLOW_KEY = "open:flow:last";
export const OPEN_EMPLOYER_PHONE = "+910000000001";
export type OpenProbe = { at: string; ok: boolean; ms: number; steps: string[]; problems: string[]; commit?: string | null };
type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

export async function openFlowLast(): Promise<OpenProbe | null> { const { data } = await db.from("reader_control").select("value").eq("key", OPEN_FLOW_KEY).maybeSingle(); return (data?.value as OpenProbe) ?? null; }

export async function openProbe(app: App, candidatePhone: string): Promise<OpenProbe> {
  const t0 = Date.now(); const problems: string[] = []; const steps: string[] = []; const made: string[] = [];
  const out = (): OpenProbe => ({ at: new Date().toISOString(), ok: problems.length === 0, ms: Date.now() - t0, steps, problems });
  const account = async (phone: string) => { const { data } = await db.from("users").upsert({ phone, last_seen_at: new Date().toISOString() }, { onConflict: "phone" }).select("id").single(); if (!data) throw new Error(`account ${phone}`); return { id: data.id as string, token: await createSession(data.id) }; };
  const as = (token: string | null) => async <T = any,>(path: string, body?: unknown, expect = 200): Promise<T> => {
    const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({}));
    if (r.status !== expect) throw new Error(`${path} → HTTP ${r.status}${j.error ? ` ${String(j.error).slice(0, 90)}` : ""} (wanted ${expect})`);
    return j as T;
  };
  try {
    const emp = await account(OPEN_EMPLOYER_PHONE), cand = await account(candidatePhone);
    const E = as(emp.token), C = as(cand.token), P = as(null);
    // the employer: a personal mailbox is refused, a mismatched domain is refused, a work email on the site's domain passes
    await E("/open/employer", { company: "Ghosted Test Co", email: "someone@gmail.com", site: "ghosted-test.example" }, 400);
    await E("/open/employer", { company: "Ghosted Test Co", email: "hiring@other.example", site: "ghosted-test.example" }, 400);
    const ve = await E("/open/employer", { company: "Ghosted Test Co", email: "hiring@ghosted-test.example", site: "https://www.ghosted-test.example/careers" });
    if (!ve.employer?.verified) problems.push("employer not verified"); steps.push("employer verified");
    const ask = { title: "Senior Product Manager, Payments", pay: "₹45–60 LPA", exp_min: 5, exp_max: 10, location: "Bengaluru", question: "Failed payouts to small merchants doubled last month. What would you look at first, and what would you leave alone?" };
    const q = (await E("/open/questions", ask)).question; made.push(q.id); steps.push("question published");
    const off = (await E("/open/questions", { ...ask, title: "Head Chef, Banquets", exp_min: 8, exp_max: 14, question: "Our banquet kitchen wastes a fifth of its prep on weekends. How would you rebuild the weekend prep plan?" })).question; made.push(off.id);
    // public: readable without an account, and on the live list
    const pub = await P(`/open/public/q/${q.id}`);
    if (pub.question?.question !== ask.question || pub.question.status !== "live") problems.push("public page does not show the live question");
    if (!((await P("/open/public/live")).questions ?? []).some((x: any) => x.id === q.id)) problems.push("question missing from the live list");
    steps.push("public page readable");
    // the candidate: relevant here, not there
    const me = await C(`/open/q/${q.id}/me`);
    if (me.state !== "ok") { problems.push(`candidate has no Record (${me.state})`); return out(); }
    if (!me.relevant) problems.push(`a product manager was found not relevant to a product role: ${JSON.stringify(me.checks)} ${me.why ?? ""}`.slice(0, 260));
    if (/@|\+91|krishnan/i.test(me.label ?? "")) problems.push(`the anonymous label carries identity: ${me.label}`);
    const other = await C(`/open/q/${off.id}/me`);
    if (other.relevant) problems.push("a product manager was found relevant to a head chef role");
    const text = "I would start with where the failures sit before touching anything: by bank, by payout rail and by time of day. A doubling in one month usually traces to one partner bank or one retry rule, not the whole system. I would leave the settlement schedule alone until that split is clear, because changing it hides the cause.";
    await C(`/open/q/${off.id}/answers`, { text, ms: 60000, pasted: false }, 403);
    steps.push("relevance holds both ways");
    if (!me.relevant) return out();
    const a = (await C(`/open/q/${q.id}/answers`, { text, ms: 240000, pasted: false })).answer;
    await C(`/open/q/${q.id}/answers`, { text, ms: 1, pasted: true }, 409);
    await E(`/open/q/${q.id}/answers`, { text }, 403);
    const pub2 = await P(`/open/public/q/${q.id}`);
    if (pub2.answers?.length !== 1 || JSON.stringify(pub2).match(/krishnan|90000 00000|0000000000/i)) problems.push("public answers are missing, or carry identity");
    steps.push("answered anonymously");
    // the employer's desk: no identity before payment
    let desk = await E("/open/desk"); let da = desk.questions.find((x: any) => x.id === q.id)?.answers_list?.[0];
    if (!da || da.contact || /krishnan/i.test(JSON.stringify(da))) problems.push("the desk shows identity before payment, or no answer");
    await E(`/open/answers/${a.id}/pay`, {}, 409);
    await E(`/open/answers/${a.id}/shortlist`, {});
    const sg = await E(`/open/answers/${a.id}/suggest`);
    if (!(sg.suggestions ?? []).length) problems.push("no follow-up was suggested");
    const fq = sg.suggestions?.[0] ?? "Why split by bank first, and not by merchant size?";
    await E(`/open/answers/${a.id}/followup`, { question: fq });
    await E(`/open/answers/${a.id}/followup`, { question: fq }, 409);
    steps.push("follow-up asked");
    const mine = (await C("/open/me")).answers.find((x: any) => x.id === a.id);
    if (!mine?.followup || mine.followup.q) problems.push("the follow-up is missing, or readable before it is opened");
    await C(`/open/answers/${a.id}/reply`, { text: "Because a single bank failing explains a doubling better than anything else." }, 409);
    const opened = (await C(`/open/answers/${a.id}/open`, {})).answer;
    if (opened.followup?.q !== fq || !(opened.followup.ms_left > 0)) problems.push("opening the follow-up did not start the window");
    await C(`/open/answers/${a.id}/reply`, { text: "Because one bank or one rail failing explains a doubling better than a general decline would, and it is the cheapest thing to confirm.", ms: 90000, pasted: false });
    steps.push("follow-up answered in the window");
    await C(`/open/answers/${a.id}/respond`, { accept: true }, 409);
    await E(`/open/answers/${a.id}/request`, {});
    await C(`/open/answers/${a.id}/respond`, { accept: true, share: { name: true, phone: false, email: false } }, 400);
    await C(`/open/answers/${a.id}/respond`, { accept: true, share: { name: true, phone: true, email: false } });
    steps.push("invited and accepted");
    const paid = await E(`/open/answers/${a.id}/pay`, {});
    if (!paid.answer?.contact?.name || !paid.answer.contact.phone || paid.answer.contact.email) problems.push(`contact after payment is not what was shared: ${JSON.stringify(paid.answer?.contact)}`);
    steps.push("paid (test path), contact received");
    await E(`/open/questions/${q.id}/close`, { outcome: "hired" });
    const end = await P(`/open/public/q/${q.id}`);
    if (end.question.status !== "closed" || !end.closed?.shortlisted?.includes(a.n) || !end.closed.conversation?.includes(a.n)) problems.push("the closed page does not say how it ended");
    if (((await P("/open/public/live")).questions ?? []).some((x: any) => x.id === q.id)) problems.push("a closed question is still on the live list");
    const after = (await C("/open/me")).answers.find((x: any) => x.id === a.id);
    if (after?.question?.status !== "closed" || after.question.outcome !== "hired") problems.push("the candidate is not told the role closed");
    await C(`/open/q/${q.id}/answers`, { text }, 409);
    steps.push("closed, outcome visible to all");
  } catch (e) { problems.push(`walk stopped: ${(e as Error).message.slice(0, 200)}`); }
  finally { for (const id of made) { await db.from("reader_control").delete().eq("key", `open:q:${id}`); await db.from("reader_control").delete().like("key", `open:a:${id}:%`); await db.from("reader_control").delete().like("key", `open:rel:${id}:%`); } }
  return out();
}
