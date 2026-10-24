/** Is this location text Bengaluru, or India-wide / remote-India (which a Bengaluru seeker can take)? Plain "Remote" with no country does not count. */
const OTHER_CITY = /\b(mumbai|pune|hyderabad|chennai|delhi|gurgaon|gurugram|noida|kolkata|ahmedabad|jaipur|chandigarh|kochi|cochin|thiruvananthapuram|trivandrum|indore|bhubaneswar|coimbatore|vadodara|surat|nagpur|lucknow|mohali|mysore|mysuru|mangalore|mangaluru|hubli|belgaum|belagavi)\b/i;
const BLR = /bengaluru|bangalore|bengalooru|\bblr\b|whitefield|electronic city|koramangala|hsr layout|marathahalli|indiranagar|bellandur|hebbal|yelahanka/i;
export const isBlr = (loc: string) => BLR.test(loc) || (/\b(india|karnataka)\b/i.test(loc) && !OTHER_CITY.test(loc));
