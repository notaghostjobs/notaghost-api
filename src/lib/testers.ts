import { env } from "./env.js";
import type { User } from "./db.js";

/** Phones allowed to use the walk-through helpers (free grant, reset, shot return). Founder's number plus OTP_TEST_PHONES,
 *  compared on the last ten digits so "+91 99520 37479", "919952037479" and "9952037479" are the same person. */
const FOUNDER = ["9952037479"];
const last10 = (p: string) => (p ?? "").replace(/\D/g, "").slice(-10);
const allowed = () => new Set([...FOUNDER, ...env.otpTestPhones.split(",").map(last10).filter((p) => p.length === 10)]);
export const isTester = (u: User) => allowed().has(last10(u.phone ?? ""));

/** People we've asked to try Radar as a favour: a real OTP like anyone else, but the list opens without payment and the
 *  morning-check link is there. RADAR_TESTERS, comma-separated, last ten digits are enough. Founders and testers included. */
const radarAllowed = () => new Set([...allowed(), ...(process.env.RADAR_TESTERS ?? "").split(",").map(last10).filter((p) => p.length === 10)]);
export const isRadarTester = (u: User) => radarAllowed().has(last10(u.phone ?? ""));
