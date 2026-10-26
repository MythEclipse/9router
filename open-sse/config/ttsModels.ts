import { GOOGLE_TTS_LANGUAGES } from "./googleTtsLanguages";

// ── Voice definitions (DRY - reused across providers) ──────────────────────
const VOICES = {
  alloy:   { id: "alloy",   name: "Alloy" },
  ash:     { id: "ash",     name: "Ash" },
  ballad:  { id: "ballad",  name: "Ballad" },
  cedar:   { id: "cedar",   name: "Cedar" },
  coral:   { id: "coral",   name: "Coral" },
  echo:    { id: "echo",    name: "Echo" },
  fable:   { id: "fable",   name: "Fable" },
  marin:   { id: "marin",   name: "Marin" },
  nova:    { id: "nova",    name: "Nova" },
  onyx:    { id: "onyx",    name: "Onyx" },
  sage:    { id: "sage",    name: "Sage" },
  shimmer: { id: "shimmer", name: "Shimmer" },
  verse:   { id: "verse",   name: "Verse" },
};

const v = (...keys) => keys.map((k) => ({ ...VOICES[k], type: "tts" }));

// 9 voices for tts-1 / tts-1-hd
const VOICES_STANDARD = v("alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer");
// 13 voices for gpt-4o-mini-tts
const VOICES_FULL = v("alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse");

// Gemini prebuilt voices (30 voices, multi-language auto-detect)
const GEMINI_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
].map((id) => ({ id, name: id, type: "tts" }));

// Xiaomi MiMo preset voices (from https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5).
// Voice id is passed via `audio.voice`; `mimo_default` = default (冰糖 on CN cluster, Mia elsewhere).
// Voices are language-independent - the spoken language is a separate hint, not bound to the voice.
const MIMO_VOICES = [
  { id: "mimo_default", name: "mimo_default" },
  { id: "冰糖",           name: "冰糖" },
  { id: "茉莉",           name: "茉莉" },
  { id: "苏打",           name: "苏打" },
  { id: "白桦",           name: "白桦" },
  { id: "Mia",           name: "Mia" },
  { id: "Chloe",         name: "Chloe" },
  { id: "Milo",          name: "Milo" },
  { id: "Dean",          name: "Dean" },
].map((v) => ({ type: "tts", ...v }));

const PHONON_VOICES = [
  ["default", "Default (Neutral)"],
  ["Zoey", "Zoey (US Female)"], ["Juniper", "Juniper (US Female)"],
  ["Everly", "Everly (US Female)"], ["Harper", "Harper (US Female)"],
  ["Hadley", "Hadley (US Female)"], ["Delia", "Delia (US Female)"],
  ["Easton", "Easton (US Male)"], ["Micah", "Micah (US Male)"],
  ["Trevor", "Trevor (US Male)"], ["Russell", "Russell (US Male)"],
  ["Preston", "Preston (US Male)"], ["Miles", "Miles (US Male)"],
  ["Maeve", "Maeve (UK Female)"], ["Freya", "Freya (UK Female)"],
  ["Pippa", "Pippa (UK Female)"], ["Elodie-Rose", "Elodie-Rose (UK Female)"],
  ["Imogen", "Imogen (UK Female)"], ["Lottie", "Lottie (UK Female)"],
  ["Bryony", "Bryony (UK Female)"], ["Alfie", "Alfie (UK Male)"],
  ["Hugh", "Hugh (UK Male)"], ["Edwin", "Edwin (UK Male)"],
  ["Spencer", "Spencer (UK Male)"], ["Toby", "Toby (UK Male)"],
  ["Teddy", "Teddy (UK Male)"], ["Azgorath", "Azgorath (Character)"],
  ["Captain Silas Blackwater", "Captain Silas (Character)"],
  ["Fairy Godmother", "Fairy Godmother (Character)"],
  ["Fennick the Young Elf", "Fennick Elf (Character)"],
  ["Grub the Ogre", "Grub the Ogre (Character)"],
  ["Master Aldric", "Master Aldric (Character)"],
  ["Morwenna of the Deep", "Morwenna (Character)"],
  ["Old Mortlake", "Old Mortlake (Character)"],
  ["Sir Bramwell", "Sir Bramwell (Character)"],
  ["The Snow Queen", "Snow Queen (Character)"],
  ["The Thing Under the Stairs", "Thing Under Stairs (Character)"],
  ["Vyrmathrax the Ancient", "Vyrmathrax (Character)"],
].map(([id, name]) => ({ id, name, type: "tts" }));
const PHONON_DEFAULT_VOICE = [{ id: "default", name: "Default", type: "tts" }];

export interface TtsProviderConfig {
  models?: { id: string; name: string; type: string }[];
  voices?: Record<string, { id: string; name: string; type: string }[]>;
  allVoices?: { id: string; name: string; type: string }[];
  defaults?: { id: string; name: string; type: string }[];
}

// ── TTS Config (config-driven, single source of truth) ─────────────────────
export const TTS_MODELS_CONFIG: Record<string, TtsProviderConfig> = {
  openai: {
    models: [
      { id: "gpt-4o-mini-tts", name: "GPT-4o Mini TTS", type: "tts" },
      { id: "tts-1-hd",        name: "TTS-1 HD",        type: "tts" },
      { id: "tts-1",           name: "TTS-1",           type: "tts" },
    ],
    voices: {
      "gpt-4o-mini-tts": VOICES_FULL,
      "tts-1":           VOICES_STANDARD,
      "tts-1-hd":        VOICES_STANDARD,
    },
    // Flat voice list (all unique voices) for backward compat
    allVoices: VOICES_FULL,
  },
  openrouter: {
    models: [
      { id: "openai/gpt-4o-mini-tts", name: "GPT-4o Mini TTS", type: "tts" },
      { id: "openai/tts-1-hd",        name: "TTS-1 HD",        type: "tts" },
      { id: "openai/tts-1",           name: "TTS-1",           type: "tts" },
    ],
    voices: {
      "openai/gpt-4o-mini-tts": VOICES_FULL,
      "openai/tts-1":           VOICES_STANDARD,
      "openai/tts-1-hd":        VOICES_STANDARD,
    },
    allVoices: VOICES_FULL,
  },
  elevenlabs: {
    models: [
      { id: "eleven_flash_v2_5",      name: "Flash v2.5 (Fastest)",      type: "tts" },
      { id: "eleven_turbo_v2_5",      name: "Turbo v2.5 (Fast)",         type: "tts" },
      { id: "eleven_multilingual_v2", name: "Multilingual v2 (Quality)",  type: "tts" },
      { id: "eleven_monolingual_v1",  name: "Monolingual v1 (English)",  type: "tts" },
    ],
    // voices come from API, not hardcoded
  },
  "edge-tts": {
    defaults: [
      { id: "en-US-AriaNeural",    name: "Aria (en-US)",    type: "tts" },
      { id: "en-US-GuyNeural",     name: "Guy (en-US)",     type: "tts" },
      { id: "en-GB-SoniaNeural",   name: "Sonia (en-GB)",   type: "tts" },
      { id: "vi-VN-HoaiMyNeural",  name: "Hoai My (vi-VN)", type: "tts" },
      { id: "vi-VN-NamMinhNeural", name: "Nam Minh (vi-VN)", type: "tts" },
      { id: "zh-CN-XiaoxiaoNeural", name: "Xiaoxiao (zh-CN)", type: "tts" },
      { id: "zh-CN-YunxiNeural",   name: "Yunxi (zh-CN)",   type: "tts" },
      { id: "fr-FR-DeniseNeural",  name: "Denise (fr-FR)",  type: "tts" },
      { id: "de-DE-KatjaNeural",   name: "Katja (de-DE)",   type: "tts" },
      { id: "ja-JP-NanamiNeural",  name: "Nanami (ja-JP)",  type: "tts" },
      { id: "ko-KR-SunHiNeural",   name: "SunHi (ko-KR)",   type: "tts" },
    ],
  },
  "local-device": {
    defaults: [
      { id: "default", name: "System Default Voice", type: "tts" },
    ],
  },
  "google-tts": {
    defaults: GOOGLE_TTS_LANGUAGES,
  },
  gemini: {
    models: [
      { id: "gemini-3.1-flash-tts-preview", name: "Gemini 3.1 Flash TTS", type: "tts" },
      { id: "gemini-2.5-flash-preview-tts", name: "Gemini 2.5 Flash TTS", type: "tts" },
      { id: "gemini-2.5-pro-preview-tts",   name: "Gemini 2.5 Pro TTS",   type: "tts" },
    ],
    voices: {
      "gemini-3.1-flash-tts-preview": GEMINI_VOICES,
      "gemini-2.5-flash-preview-tts": GEMINI_VOICES,
      "gemini-2.5-pro-preview-tts":   GEMINI_VOICES,
    },
    allVoices: GEMINI_VOICES,
  },
  "xiaomi-mimo": {
    models: [
      { id: "mimo-v2.5-tts", name: "MiMo V2.5 TTS", type: "tts" },
    ],
    voices: {
      "mimo-v2.5-tts": MIMO_VOICES,
    },
  },
  "ollama-local": {
    voices: {
      "phonon": PHONON_VOICES,
      "phonon:latest": PHONON_VOICES,
      "phonon:multilingual": PHONON_VOICES,
      "phonon:40m-multilingual": PHONON_VOICES,
      "phonon:en": PHONON_DEFAULT_VOICE,
      "phonon:31m-en": PHONON_DEFAULT_VOICE,
      "phonon:40m-en": PHONON_DEFAULT_VOICE,
      "phonon:de": PHONON_DEFAULT_VOICE,
      "phonon:40m-de": PHONON_DEFAULT_VOICE,
      "phonon:es": PHONON_DEFAULT_VOICE,
      "phonon:40m-es": PHONON_DEFAULT_VOICE,
      "phonon:fr": PHONON_DEFAULT_VOICE,
      "phonon:40m-fr": PHONON_DEFAULT_VOICE,
      "phonon:pt": PHONON_DEFAULT_VOICE,
      "phonon:40m-pt": PHONON_DEFAULT_VOICE,
    },
  },
};

// ── Helper: get voices for a specific model ────────────────────────────────
export function getTtsVoicesForModel(provider, modelId) {
  const cfg = TTS_MODELS_CONFIG[provider];
  if (!cfg?.voices) return null;
  return cfg.voices[modelId] || cfg.allVoices || null;
}

// ── Build flat entries for PROVIDER_MODELS backward compat ─────────────────
export function buildTtsProviderModels(): Record<string, { id: string; name: string; type: string }[]> {
  const entries: Record<string, { id: string; name: string; type: string }[]> = {};
  for (const [provider, cfg] of Object.entries(TTS_MODELS_CONFIG)) {
    if (cfg.models) entries[`${provider}-tts-models`] = cfg.models;
    if (cfg.allVoices) entries[`${provider}-tts-voices`] = cfg.allVoices;
    if (cfg.defaults) entries[provider] = cfg.defaults;
  }
  // Keep openai-tts-voices key pointing to full voice list for backward compat
  entries["openai-tts-voices"] = TTS_MODELS_CONFIG.openai.allVoices;
  entries["openrouter-tts-voices"] = TTS_MODELS_CONFIG.openrouter.allVoices;
  return entries;
}
