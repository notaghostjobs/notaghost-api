const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};
const opt = (k: string, d = "") => process.env[k] ?? d;

export const env = {
  port: Number(opt("PORT", "8080")),
  appOrigin: opt("APP_ORIGIN", "http://localhost:5173"),
  supabaseUrl: need("SUPABASE_URL"),
  supabaseServiceKey: need("SUPABASE_SERVICE_ROLE_KEY"),
  anthropicKey: opt("ANTHROPIC_API_KEY"),
  razorpayKeyId: opt("RAZORPAY_KEY_ID"),
  razorpayKeySecret: opt("RAZORPAY_KEY_SECRET"),
  razorpayWebhookSecret: opt("RAZORPAY_WEBHOOK_SECRET"),
  waToken: opt("WA_TOKEN", ""),                    // WhatsApp Cloud API: permanent system-user token (Meta → Render, never chat)
  waPhoneId: opt("WA_PHONE_ID", ""),               // the Ghosted number's phone number ID
  waVerifyToken: opt("WA_VERIFY_TOKEN", ""),       // what Meta sends back on the webhook handshake
  waAppSecret: opt("WA_APP_SECRET", ""),           // the app secret (App settings → Basic): verifies every webhook delivery when set
  otpProvider: opt("OTP_PROVIDER", "dev") as "msg91" | "email" | "dev",
  msg91AuthKey: opt("MSG91_AUTHKEY"),
  msg91TemplateId: opt("MSG91_TEMPLATE_ID"),               // SMS (DLT) template id
  msg91WaNumber: opt("MSG91_WA_NUMBER"),                     // WhatsApp sender, e.g. 919xxxxxxxxx; empty = SMS only
  msg91WaTemplate: opt("MSG91_WA_TEMPLATE"),                 // WhatsApp authentication template name
  msg91WaNamespace: opt("MSG91_WA_NAMESPACE"),               // template namespace from Meta
  otpTestPhones: opt("OTP_TEST_PHONES", ""),                 // comma-separated +91 numbers that always get OTP_DEV_CODE
  resendKey: opt("RESEND_API_KEY"),
};

export const PRICES = {
  sharpen: { paise: 49900, shots: 10, days: 30 },
  build: { paise: 99900, shots: 10, days: 30 },
} as const;
