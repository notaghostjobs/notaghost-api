/** A job as a hiring system reports it. Nothing inferred. */
export interface FeedJob {
  id: string;                 // the system's own id, stable across days
  title: string;
  location: string;           // as given; may be "" or "Multiple"
  url: string;
  posted_at: string | null;   // ISO, the system's own date (created/published)
  updated_at: string | null;
  posted_text: string | null; // "Posted 3 Days Ago" when that is all the system gives
  raw?: unknown;
}

export interface Feed {
  system: string;             // "greenhouse" ...
  ref: string;                // what read() needs next time
  board_url: string;          // human page
  company_name: string | null;// the system's own name for the employer, when it tells us (used to catch wrong matches)
  jobs: FeedJob[];
  debug?: string;             // how the read went (pages, totals) — shown in the self-test
}

export interface System {
  id: string;
  /** If this URL belongs to the system, the ref to read; else null. */
  detect(url: string): string | null;
  /** Read the whole feed. Throws only on network failure; returns null when the ref does not exist. */
  read(ref: string): Promise<Feed | null>;
}

/** Self-test runs read a few pages only; a real read goes to the end. Readers check `mode.quick`. */
export const mode = { quick: false };
