import { db, currentResume } from "./db.js";
import { processResume } from "../engine/worker.js";

/**
 * The current résumé, guaranteed parsed. A row can be left with no parsed text when the process restarts between the
 * upload and the end of parsing (a deploy, a crash); the user then sees "on file" but every step says "upload first".
 * Here it is parsed on sight; if the file cannot be read, the row is removed so the user is asked for a fresh upload.
 */
export async function currentParsedResume<T extends { id: string; parsed: any }>(userId: string, cols = "id, parsed"): Promise<T | null> {
  const r = await currentResume<T>(userId, cols.includes("parsed") ? cols : `${cols}, parsed`);
  if (!r) return null;
  if (r.parsed) return r;
  try {
    const parsed = await processResume(r.id);
    if (parsed) return { ...r, parsed } as T;
  } catch (e) {
    console.error("[resume] reparse failed", r.id, (e as Error).message);
  }
  await db.from("resumes").delete().eq("id", r.id);
  return null;
}
