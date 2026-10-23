# notaghost-api

Node 20 · Hono · Supabase (Mumbai) · Razorpay · Anthropic. Deployed on Railway.

## Run locally
    cp .env.example .env   # fill SUPABASE_SERVICE_ROLE_KEY at minimum
    npm i && npm run dev   # http://localhost:8080/health

## Set up the database (once)
Supabase → SQL Editor → paste `supabase/migrations/0001_init.sql` → Run.

## Routes
    POST /auth/otp        {phone}            -> sends code
    POST /auth/verify     {phone, code}      -> {token, user}
    GET  /auth/me
    POST /resumes         multipart file     -> {resume}
    GET  /resumes/current
    GET  /shots/plan                         -> {sharpen, build} active plans
    POST /shots           {product, posting_url|posting_text} -> spends one shot
    GET  /shots/:id
    POST /payments/order  {product}          -> Razorpay order for Checkout
    POST /payments/confirm {order_id, payment_id, signature}
    POST /payments/webhook                   (Razorpay → payment.captured)
    GET  /payments

Pricing lives in `src/lib/env.ts` (`PRICES`): Sharpen ₹499, Build ₹999, 25 shots or 30 days.
