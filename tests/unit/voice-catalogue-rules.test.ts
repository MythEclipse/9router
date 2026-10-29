import { describe, expect, test } from "vitest"
import {
	addVoice,
	CUSTOM_LANGUAGE_CODE,
	groupByListedLanguages,
	languageLabel,
	listedLanguages,
	sortedLanguages,
	spokenLanguages,
	type VoiceEntry,
	type VoiceLanguage,
	voiceId,
	voiceName,
	voicesForLanguage,
} from "../../apps/api/src/domain/voice-catalogue"

const LANG = new Intl.DisplayNames(["en"], { type: "language" })

const entry = (id: string, lang: string): VoiceEntry => ({
	id,
	name: id,
	lang,
	gender: "",
})

describe("languageLabel", () => {
	test("names a language it knows", () => {
		expect(languageLabel("en", LANG)).toBe("English")
	})

	test("an unrecognised code keeps the code instead of throwing", () => {
		// Intl throws on these, and one bad bucket must not cost the operator the whole list.
		expect(languageLabel("multi", LANG)).toBe("multi")
		expect(languageLabel(CUSTOM_LANGUAGE_CODE, LANG)).toBe(CUSTOM_LANGUAGE_CODE)
		expect(languageLabel("xx-zzz", LANG)).toBe("xx-zzz")
	})
})

describe("voiceName", () => {
	test("a real name is kept", () => {
		expect(voiceName("Thalia", "fallback")).toBe("Thalia")
	})

	test("blank and non-string names fall back", () => {
		// An empty name renders as a blank button the operator cannot identify.
		expect(voiceName("", "fallback")).toBe("fallback")
		expect(voiceName("   ", "fallback")).toBe("fallback")
		expect(voiceName(undefined, "fallback")).toBe("fallback")
		expect(voiceName(42, "fallback")).toBe("fallback")
	})
})

describe("voiceId", () => {
	test("first usable candidate wins", () => {
		expect(voiceId(["canonical", "name"])).toBe("canonical")
	})

	test("skips blank candidates", () => {
		expect(voiceId([undefined, "", "name"])).toBe("name")
		expect(voiceId([])).toBe("")
	})
})

describe("spokenLanguages", () => {
	test("primary first, verified after", () => {
		expect(spokenLanguages("en", ["es", "fr"])).toEqual(["en", "es", "fr"])
	})

	test("a missing primary becomes en, not an empty bucket", () => {
		expect(spokenLanguages(undefined, ["es"])).toEqual(["en", "es"])
	})

	test("the primary is not repeated when it is also verified", () => {
		// ElevenLabs does list the primary language among the verified ones.
		expect(spokenLanguages("en", ["en", "es"])).toEqual(["en", "es"])
	})

	test("empty entries are dropped", () => {
		expect(spokenLanguages("en", ["", "es", ""])).toEqual(["en", "es"])
	})
})

describe("listedLanguages", () => {
	test("a listed set is used as-is", () => {
		expect(listedLanguages(["en", "es"])).toEqual(["en", "es"])
	})

	test("an empty list falls back to en rather than dropping the voice", () => {
		// Dropping it would hide a usable voice from every language filter.
		expect(listedLanguages([])).toEqual(["en"])
		expect(listedLanguages(null)).toEqual(["en"])
		expect(listedLanguages("en")).toEqual(["en"])
	})

	test("non-string members are filtered", () => {
		expect(listedLanguages(["en", 7, null, "es"])).toEqual(["en", "es"])
	})
})

describe("addVoice", () => {
	test("the same voice is not added twice to one bucket", () => {
		// Two identical buttons appear in the picker and only one of them is selectable.
		const byLang: Record<string, VoiceLanguage> = {}
		addVoice(byLang, "en", entry("a", "en"), LANG)
		addVoice(byLang, "en", entry("a", "en"), LANG)
		expect(byLang.en.voices).toHaveLength(1)
	})

	test("the same voice id can appear under two languages", () => {
		const byLang: Record<string, VoiceLanguage> = {}
		addVoice(byLang, "en", entry("a", "en"), LANG)
		addVoice(byLang, "es", entry("a", "es"), LANG)
		expect(byLang.en.voices).toHaveLength(1)
		expect(byLang.es.voices).toHaveLength(1)
	})

	test("a bucket is created with its display name", () => {
		const byLang: Record<string, VoiceLanguage> = {}
		addVoice(byLang, "en", entry("a", "en"), LANG)
		expect(byLang.en.name).toBe("English")
	})
})

describe("sortedLanguages", () => {
	test("sorted by display name", () => {
		const byLang = {
			es: { code: "es", name: "Spanish", voices: [] },
			en: { code: "en", name: "English", voices: [] },
		}
		expect(sortedLanguages(byLang).map((l) => l.code)).toEqual(["en", "es"])
	})

	test("Custom sorts last, not among the languages", () => {
		// It is the absence of a language; sorting it by name buries real languages behind it.
		const byLang = {
			[CUSTOM_LANGUAGE_CODE]: { code: CUSTOM_LANGUAGE_CODE, name: "Custom", voices: [] },
			zu: { code: "zu", name: "Zulu", voices: [] },
			en: { code: "en", name: "English", voices: [] },
		}
		expect(sortedLanguages(byLang).map((l) => l.code)).toEqual(["en", "zu", CUSTOM_LANGUAGE_CODE])
	})
})

describe("voicesForLanguage", () => {
	test("a known language returns its voices", () => {
		const byLang = { en: { code: "en", name: "English", voices: [entry("a", "en")] } }
		expect(voicesForLanguage(byLang, "en")).toHaveLength(1)
	})

	test("an unknown language returns empty, not every voice", () => {
		// Answering with everything would make a typo in ?lang= look like a successful filter.
		const byLang = { en: { code: "en", name: "English", voices: [entry("a", "en")] } }
		expect(voicesForLanguage(byLang, "xx")).toEqual([])
	})

	test("no filter is not the same as filtering for everything", () => {
		const byLang = { en: { code: "en", name: "English", voices: [entry("a", "en")] } }
		expect(voicesForLanguage(byLang, null)).toEqual([])
	})
})

describe("groupByListedLanguages", () => {
	test("a voice in two languages lands in both buckets", () => {
		const voices = [{ id: "a", langs: ["en", "es"] }]
		const catalogue = groupByListedLanguages(
			voices,
			(v) => v.langs,
			(v, code) => entry(v.id, code),
			LANG,
		)
		expect(catalogue.languages.map((l) => l.code)).toEqual(["en", "es"])
		expect(catalogue.byLang.en.voices).toHaveLength(1)
		expect(catalogue.byLang.es.voices).toHaveLength(1)
	})

	test("repeated language codes produce one bucket with one voice", () => {
		const voices = [{ id: "a", langs: ["en", "en"] }]
		const catalogue = groupByListedLanguages(
			voices,
			(v) => v.langs,
			(v, code) => entry(v.id, code),
			LANG,
		)
		expect(catalogue.byLang.en.voices).toHaveLength(1)
	})

	test("an empty voice list yields an empty catalogue, not a stray bucket", () => {
		const catalogue = groupByListedLanguages<{ id: string; langs: string[] }>(
			[],
			(v) => v.langs,
			(v, code) => entry(v.id, code),
			LANG,
		)
		expect(catalogue.languages).toEqual([])
		expect(catalogue.byLang).toEqual({})
	})
})
