import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { env } from "./lib/env.js";
import { auth } from "./routes/auth.js";
import { resumes } from "./routes/resumes.js";
import { shots } from "./routes/shots.js";
import { payments } from "./routes/payments.js";

const app = new Hono();
app.use("*", logger());
app.use("*", cors({ origin: [env.appOrigin, "http://localhost:5173"], allowHeaders: ["authorization", "content-type"] }));

app.get("/health", (c) => c.json({ ok: true, v: "0.1.0" }));
app.route("/auth", auth);
app.route("/resumes", resumes);
app.route("/shots", shots);
app.route("/payments", payments);

app.onError((err, c) => {
  const status = (err as { status?: number }).status ?? 500;
  if (status >= 500) console.error(err);
  return c.json({ error: status >= 500 ? "Something broke on our side." : err.message }, status as 400);
});

serve({ fetch: app.fetch, port: env.port }, () => console.log(`notaghost-api on :${env.port}`));
