/** Is this location text Bengaluru, or India-wide / remote-India (which a Bengaluru seeker can take)?
 *  Names Bengaluru → yes. Names any other place ("Bhopal, India", "Asia>India>Maharashtra>Thane", "Visakhapatnam") → no,
 *  whether or not we know the city (10 Nov: a fixed list of other cities let 6% of "Bengaluru" roles through from towns
 *  not on it). Only a location with no place word left once "India"/"Karnataka"/"Remote" and the like are removed counts
 *  as India-wide. Plain "Remote" with no country does not count. */
const BLR = /bengaluru|bangalore|bengalooru|\bblr\b|whitefield|electronic city|koramangala|hsr layout|marathahalli|indiranagar|bellandur|hebbal|yelahanka/i;
const INDIA = /\b(india|karnataka)\b/i;
const WIDE = /\b(india|in|ind|karnataka|ka|remote|asia|apac|work from home|wfh|pan[- ]?india|multiple locations|all locations|any location|anywhere|virtual|home|office|locations?|hybrid|flexible|facet|na|n\/a|tbd|\d+)\b/gi;
export const isBlr = (loc: string) => {
  const t = loc ?? "";
  if (BLR.test(t)) return true;
  if (!INDIA.test(t)) return false;
  const rest = t.replace(WIDE, " ").replace(/[^a-z]+/gi, " ").trim();
  return rest === "";
};
