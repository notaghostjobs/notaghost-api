// One job: put a short, plain message in someone's work inbox. Used by Open by notaghost.jobs to prove an employer owns the
// address they gave. Resend over HTTPS; the key lives in Render (RESEND_API_KEY) and never in chat or in Git.
import { env } from "./env.js";

export const mailReady = () => !!env.resendKey;
const FROM = process.env.MAIL_FROM ?? "Open by notaghost.jobs <open@notaghost.jobs>";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/** Sends one message. True when the mail service accepted it; false (never a throw) when it did not or is not set up. */
export async function sendMail(m: { to: string; subject: string; lines: string[]; code?: string }): Promise<boolean> {
  if (!env.resendKey) return false;
  const text = [...m.lines.slice(0, 1), ...(m.code ? ["", m.code, ""] : [""]), ...m.lines.slice(1), "", "Open by notaghost.jobs"].join("\n");
  const html = `<div style="font:16px/1.5 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:#0c0c10;max-width:480px">`
    + `<p>${esc(m.lines[0] ?? "")}</p>`
    + (m.code ? `<p style="font:800 34px/1 -apple-system,Segoe UI,Inter,Arial,sans-serif;letter-spacing:.14em;margin:22px 0">${esc(m.code)}</p>` : "")
    + m.lines.slice(1).map((l) => `<p style="color:#4e4e58">${esc(l)}</p>`).join("")
    + `<p style="color:#8b8b98;font-size:13px;margin-top:26px">Open by notaghost.jobs</p></div>`;
  try {
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${env.resendKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [m.to], subject: m.subject, text, html }) });
    if (!r.ok) console.error("[mail]", r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.error("[mail]", (e as Error).message); return false; }
}
