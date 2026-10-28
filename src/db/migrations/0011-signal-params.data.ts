/**
 * What migration 0011 sets. Literals, so the migration stays the same after it has been applied. Thresholds for the
 * transcript signals (`src/audit/v2/signals.ts`) and the S2 loop rule, which reads the Repetition metric's params.
 */

/** Common romanised Hindi words; left out: ones that are also English words ("main", "do", "to", "hi", "me", "the"). */
const ROMANISED_HINDI = [
  "hai", "hain", "haan", "haanji", "nahi", "nahin", "kya", "kyun", "kyon", "kaise", "kaisa", "kaisi", "kab", "kahan",
  "kaun", "kitna", "kitne", "aap", "aapka", "aapki", "aapko", "apna", "apne", "mera", "meri", "mere", "mujhe", "hum",
  "humko", "hamara", "tum", "tumhara", "theek", "thik", "accha", "acha", "achha", "ji", "bhai", "bhaiya", "kar",
  "karo", "karna", "karke", "karte", "karenge", "raha", "rahe", "rahi", "hoga", "hogi", "hoon", "tha", "thi", "wala",
  "wali", "abhi", "kal", "aaj", "baat", "bolo", "bataiye", "batao", "samjha", "samajh", "matlab", "lekin", "aur",
  "sab", "kuch", "kuchh", "dijiye", "kijiye", "chahiye", "sakta", "sakte", "sakti", "gaya", "gayi", "diya", "liya",
  "dekho", "suno", "yaar", "phir", "fir", "iska", "uska", "kaam", "paisa", "paise", "ghar", "log", "wahi", "yahi",
  "woh", "yeh", "mein", "ka", "ki", "ke", "ko", "se", "ne", "bhi", "baad", "pehle", "itna", "itne", "laga", "dena",
  "lena", "jana", "aana", "kharab", "zaroor", "bilkul",
];

export const SIGNAL_PARAMS: Record<string, Record<string, unknown>> = {
  repetition: { similarity: 0.85, min_repeats: 3, min_chars: 15, unclear_reply_max_words: 1 },
  stalling_filler: {
    stalling_phrases: ["let me check", "i will get back to you", "one moment", "ek minute", "main check karke batata"],
    filler_words: ["umm", "uh", "hmm", "actually", "basically", "matlab"],
    per_100_words: { full: 1, partial: 3 },
    min_agent_words: 20,
  },
  language_match: { min_words: 2, hindi_ratio: 0.3, switch_turns: 2, mismatch_turns: 2, romanised_hindi_words: ROMANISED_HINDI },
};

/** v4 of each 10-metric scorecard: v3 with the params above. Agents on v3 move to v4. */
export const V4_SCORECARDS = [
  { scorecard_id: "default", from: 3, version: 4, name: "Default (10 metrics)" },
  { scorecard_id: "hansa", from: 3, version: 4, name: "Hansa (10 metrics)" },
];
