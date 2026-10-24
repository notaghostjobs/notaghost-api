import { ATS } from "./ats.js";
import { keka, darwinbox, page } from "./page.js";
import type { System } from "./types.js";

export const SYSTEMS: System[] = [...ATS, keka, darwinbox];
export const byId = (id: string): System | undefined => (id === "page" ? page : SYSTEMS.find((s) => s.id === id));

/** Which system does this URL belong to, and what ref would we read? */
export function detect(url: string): { system: string; ref: string } | null {
  for (const s of SYSTEMS) { const ref = s.detect(url); if (ref) return { system: s.id, ref }; }
  return null;
}
export { page };
export type { Feed, FeedJob, System } from "./types.js";
