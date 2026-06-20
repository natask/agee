// agee — settings-intent parser.
//
// Turns a spoken/typed request ("be terser", "set the system prompt to …",
// "use model gpt-4o-mini") into a concrete patch for the gateway runtime agent
// profile. This is the "change settings by talking to the agent" path: the
// extension is the agent surface, so the mapping from natural language to a
// profile patch lives here, deterministically, and the patch is applied via the
// gateway's existing PUT /v1/agent/profile contract (field names unchanged).
//
// parseSettingsIntent(text, current) -> { patch, summary } | null
//   text    : the user's plain-language request
//   current : the current effective profile (used for relative changes like
//             "be terser", which shrink the existing voice_max_chars)
// Returns null when the text is not a settings change (so callers fall back to
// the normal conversational path).
//
// An ES module, imported by both background.js (module service worker) and
// options.js (module script in the options page), so it stays the single
// source of truth and dependency-free.

// Profile fields the gateway accepts. Kept aligned with moa_gateway's
// lib/agent-profile.js PROFILE_FIELDS; we never invent field names.
const PROFILE_FIELDS = ["system_prompt", "model", "temperature", "voice_max_chars", "language", "voice"];

// The Gemini Live core-8 voices the gateway accepts for the agent's OWN spoken
// voice. Kept aligned with moa_gateway's lib/agent-profile.js CORE_VOICES. Google
// labels these by style, not gender, so WE define the gender aliases below.
const CORE_VOICES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];
const CORE_VOICES_BY_LOWER = new Map(CORE_VOICES.map((name) => [name.toLowerCase(), name]));
// Gender aliases we define (the gateway has no gender concept): a woman's voice
// maps to Aoede, a man's voice to Charon.
const FEMALE_VOICE = "Aoede";
const MALE_VOICE = "Charon";

const DEFAULT_VOICE_MAX_CHARS = 280;
const TERSE_MAX_CHARS = 140;
const VERBOSE_MAX_CHARS = 600;

function clampVoiceMaxChars(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(20, Math.min(4000, Math.round(value)));
}

// "set the system prompt to X" / "system prompt: X" / "your prompt is X".
function matchSystemPrompt(raw) {
  const m =
    raw.match(/(?:set|change|make|update)?\s*(?:your\s+|the\s+)?system\s*prompt\s*(?:to|=|:|should be|is)\s+([\s\S]+)/i) ||
    raw.match(/(?:set|change|make|update)\s+(?:your\s+|the\s+)?prompt\s+(?:to|=|:)\s+([\s\S]+)/i);
  if (!m) return null;
  const value = stripQuotes(m[1].trim());
  if (!value) return null;
  return { patch: { system_prompt: value }, summary: `system prompt set (${value.length} chars)` };
}

// "set the model to X" / "use model X" / "use the gateway model X".
function matchModel(raw) {
  const m =
    raw.match(/(?:set|change|switch|use)\s+(?:the\s+)?(?:gateway\s+)?model\s+(?:to|=|:)?\s*([^\s,.;]+)/i) ||
    raw.match(/(?:use|switch to)\s+(?:the\s+)?model\s+([^\s,.;]+)/i);
  if (!m) return null;
  const value = stripQuotes(m[1].trim());
  if (!value) return null;
  return { patch: { model: value }, summary: `model set to ${value}` };
}

// "set temperature to 0.2" / "temperature 0.7".
function matchTemperature(raw) {
  const m = raw.match(/temperature\s*(?:to|=|:)?\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0 || value > 2) return null;
  return { patch: { temperature: value }, summary: `temperature set to ${value}` };
}

// Explicit length: "set voice max chars to 200", "limit replies to 120 characters",
// "keep replies under 90 chars".
function matchVoiceMaxChars(raw) {
  const m =
    raw.match(/(?:voice\s*max\s*chars?|max\s*chars?|character\s*limit)\s*(?:to|=|:)?\s*(\d+)/i) ||
    raw.match(/(?:limit|keep|cap)\s+(?:the\s+)?(?:spoken\s+)?repl(?:y|ies)\s+(?:to|under|at|below)\s+(\d+)\s*(?:char|character)/i);
  if (!m) return null;
  const value = clampVoiceMaxChars(Number(m[1]));
  if (value == null) return null;
  return { patch: { voice_max_chars: value }, summary: `spoken reply limit set to ${value} chars` };
}

// "set language to French" / "reply in Spanish" / "speak English".
function matchLanguage(raw) {
  const m =
    raw.match(/(?:set\s+)?language\s*(?:to|=|:)\s*([a-zA-Z][a-zA-Z \-]{0,38})/i) ||
    raw.match(/(?:reply|respond|answer|speak|talk)\s+(?:to me\s+)?in\s+([a-zA-Z][a-zA-Z \-]{0,38})/i);
  if (!m) return null;
  const value = stripQuotes(m[1].trim());
  if (!value) return null;
  return { patch: { language: value }, summary: `language set to ${value}` };
}

// Change the agent's OWN spoken voice. Three shapes, in priority order:
//   - gender alias:  "female"/"woman"/"sound like a woman" -> Aoede;
//                    "male"/"man"/"sound like a man"        -> Charon.
//   - explicit name: "use the Charon voice", "use voice Leda", "switch to Kore",
//                    "set voice to Aoede" -> that core-8 voice (case-insensitive).
// Anchored on the word "voice" or an explicit "sound like a man/woman" so it
// never swallows ordinary system-prompt text.
function matchVoice(raw) {
  // Explicit core-voice by name wins when a real voice name is present, so
  // "use the Charon voice" picks Charon rather than the male alias.
  const named =
    raw.match(/\b(?:use|set|change|switch(?:\s+to)?|make)\b[^.]*?\bvoice\b\s*(?:to|=|:|should be|is|named|called)?\s*([a-zA-Z]+)/i) ||
    raw.match(/\b(?:use|switch\s+to)\s+(?:the\s+)?([a-zA-Z]+)\s+voice\b/i) ||
    raw.match(/\b(?:use|set|switch\s+to)\s+voice\s+([a-zA-Z]+)/i);
  if (named) {
    const canonical = CORE_VOICES_BY_LOWER.get(stripQuotes(named[1].trim()).toLowerCase());
    if (canonical) {
      return { patch: { voice: canonical }, summary: `voice set to ${canonical}` };
    }
  }

  // "switch to Kore" / "use Aoede" — a bare core-voice name after a switch verb,
  // with no "voice" word. Safe because we only accept the fixed core-8 names.
  const bare = raw.match(/\b(?:switch\s+to|use|set|change\s+to|sound\s+like)\s+(?:the\s+|a\s+|an\s+)?([a-zA-Z]+)\b/i);
  if (bare) {
    const canonical = CORE_VOICES_BY_LOWER.get(stripQuotes(bare[1].trim()).toLowerCase());
    if (canonical) {
      return { patch: { voice: canonical }, summary: `voice set to ${canonical}` };
    }
  }

  // Gender aliases: only fire when the request is clearly about the voice/sound,
  // not any incidental mention of "woman"/"man".
  const aboutVoice = /\bvoice\b/i.test(raw) || /\bsound\s+like\b/i.test(raw) || /\bspeak\s+like\b/i.test(raw);
  if (aboutVoice) {
    if (/\b(female|woman|girl|feminine|lady)\b/i.test(raw)) {
      return { patch: { voice: FEMALE_VOICE }, summary: `voice set to ${FEMALE_VOICE}` };
    }
    if (/\b(male|man|guy|masculine|boy)\b/i.test(raw)) {
      return { patch: { voice: MALE_VOICE }, summary: `voice set to ${MALE_VOICE}` };
    }
  }
  return null;
}

// Relative terseness: "be terser", "be more concise", "shorter replies".
function matchTerser(raw, current) {
  if (!/\b(terser|more\s+terse|be\s+terse|more\s+concise|be\s+concise|shorter|be\s+brief|more\s+brief|less\s+wordy)/i.test(raw)) {
    return null;
  }
  const base = numberOr(current?.voice_max_chars, DEFAULT_VOICE_MAX_CHARS);
  // Halve toward a terse floor so repeated requests keep shrinking.
  const next = clampVoiceMaxChars(Math.min(TERSE_MAX_CHARS, Math.floor(base / 2)));
  return { patch: { voice_max_chars: next }, summary: `terser: spoken reply limit ${base} → ${next} chars` };
}

// Relative verbosity: "be more verbose", "longer replies", "more detail".
function matchVerbose(raw, current) {
  if (!/\b(more\s+verbose|be\s+verbose|longer\s+repl|more\s+detail|less\s+terse|more\s+wordy)/i.test(raw)) {
    return null;
  }
  const base = numberOr(current?.voice_max_chars, DEFAULT_VOICE_MAX_CHARS);
  const next = clampVoiceMaxChars(Math.max(VERBOSE_MAX_CHARS, base * 2));
  return { patch: { voice_max_chars: next }, summary: `more verbose: spoken reply limit ${base} → ${next} chars` };
}

// Order matters: specific field setters before the relative shorthands, and
// system-prompt last among setters because its value is free text that could
// otherwise swallow a "model"/"temperature" mention inside the prompt body.
const MATCHERS = [
  matchModel,
  matchTemperature,
  // matchVoiceMaxChars before matchVoice so "voice max chars to 200" sets the
  // length limit, not the spoken voice.
  matchVoiceMaxChars,
  matchVoice,
  matchLanguage,
  matchTerser,
  matchVerbose,
  matchSystemPrompt,
];

function parseSettingsIntent(text, current) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  // A leading verb is a strong settings signal but not required for the
  // shorthands ("be terser"). Each matcher is responsible for its own anchor.
  for (const matcher of MATCHERS) {
    const result = matcher(raw, current);
    if (result && hasUsableFields(result.patch)) {
      return result;
    }
  }
  return null;
}

function hasUsableFields(patch) {
  return Boolean(patch) && Object.keys(patch).some((key) => PROFILE_FIELDS.includes(key));
}

// Detect a *question about* the agent's prompt history (not a change):
// "what prompts have I set?", "how many system prompts have I asked you?",
// "show my prompt history", "what changes have I made to your prompt?".
// Returns { kind: "prompt_history" } or null. Kept here so the natural-language
// surface for the agent profile stays in one file.
function parseProfileQueryIntent(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const mentionsPrompt = /\bprompts?\b/i.test(raw);
  const asksHistory =
    /\bprompt\s+history\b/i.test(raw) ||
    (mentionsPrompt && /\bhow many\b/i.test(raw)) ||
    (mentionsPrompt && /\b(list|show|what(?:'s| is| are)?)\b/i.test(raw) && /\b(set|asked|made|given|history|so far|have i)\b/i.test(raw)) ||
    (/\bwhat\b/i.test(raw) && /\bchanges?\b/i.test(raw) && /\b(prompt|system|behaviou?r)\b/i.test(raw));
  return asksHistory ? { kind: "prompt_history" } : null;
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stripQuotes(value) {
  const trimmed = String(value || "").trim();
  const quoted = trimmed.match(/^["'“”'](.*)["'“”']$/s);
  return (quoted ? quoted[1] : trimmed).trim();
}

export { parseSettingsIntent, parseProfileQueryIntent, PROFILE_FIELDS };
