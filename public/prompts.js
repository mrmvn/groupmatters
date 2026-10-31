// One witty line above the composer, chosen once per browser session.
// No display names, no time-of-day awareness: every line works for anyone, anytime.
// Kept out of labels.js because it's decoration, not interface wording.

export const PROMPTS = [
  // Warm / invitational
  "What does your group need to decide?",
  "Is it time to ask the group your most important question?",
  "What's the question that's been waiting?",
  "What does the group keep coming back to?",
  "The group can only answer what someone writes down.",
  "What's the one thing only the group can settle?",
  // Playful / self-aware
  "What are you lot up to?",
  "Collectively organising?",
  "Time to harness this collective intelligence.",
  "One more question won't hurt. Probably.",
  "Democracy: now with a text box.",
  "Somewhere to put the question before it puts you.",
  "No agenda? Start with a question.",
  "You bring the question; the group brings the rest.",

  // Dry / wry
  "What's the unresolved thing this time?",
  "Another question? Go on then.",
  "Put it here before it becomes a meeting.",
  "The question you were going to raise anyway.",
  "Long list? Short question.",
  "If you're unsure, that's usually a question.",

  // Purposeful / encouraging
  "Every decision starts as a question someone dared to ask.",
  "A good question, written down, is a decision waiting to happen.",
  "Small question, big progress.",
  "What would move things forward today?",
  "Naming it is half the meeting.",
];

const KEY = "qr:prompt";
let cached = null;

/** The line for this browser session, stable for the life of the tab (and across re-renders). */
export function promptOfSession() {
  if (cached) return cached;
  let saved = null;
  try {
    saved = sessionStorage.getItem(KEY);
  } catch {
    // no sessionStorage (private mode, tests): fall through to a fresh pick, cached in memory
  }
  if (saved && PROMPTS.includes(saved)) cached = saved;
  else {
    cached = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
    try {
      sessionStorage.setItem(KEY, cached);
    } catch {}
  }
  return cached;
}
