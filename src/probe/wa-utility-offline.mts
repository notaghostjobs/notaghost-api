// Offline check: a WhatsApp template is used under its new name only when Meta holds it as an approved UTILITY template.
// Run: npx tsx src/probe/wa-utility-offline.mts   Nothing here touches the network.
for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL']) process.env[k] ??= k.endsWith("_URL") ? "https://offline.invalid" : "offline";   // stand-in settings: nothing is called
const { utilityOk, TEMPLATES } = await import("../routes/whatsapp.js");
let fail = 0; const ok = (n: string, c: boolean) => { if (c) console.log("  ✓", n); else { fail++; console.log("  ✗", n); } };
ok("approved and utility: used", utilityOk([{ name: "open_by_reply", status: "APPROVED", category: "UTILITY" }], "open_by_reply"));
ok("approved but marketing: not used", !utilityOk([{ name: "open_by_invite", status: "APPROVED", category: "MARKETING" }], "open_by_invite"));
ok("utility but still in review: not used", !utilityOk([{ name: "open_by_invited", status: "PENDING", category: "UTILITY" }], "open_by_invited"));
ok("another template's row does not count", !utilityOk([{ name: "open_by_invite_old", status: "APPROVED", category: "UTILITY" }], "open_by_invite"));
ok("unknown template: not used", !utilityOk([], "open_by_invited"));
const names = TEMPLATES.map((t: any) => t.name);
ok("the reworded invitation is submitted, and the earlier ones are kept", names.includes("open_by_invited") && names.includes("ghosted_open_invite") && names.includes("open_by_invite"));
ok("no template name is listed twice", new Set(names).size === names.length);
console.log(fail ? `FAILED ${fail}` : "all passed"); process.exit(fail ? 1 : 0);
