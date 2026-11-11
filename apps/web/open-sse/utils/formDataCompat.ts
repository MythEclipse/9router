/**
 * Multipart bodies must be built with the FormData implementation that the
 * `fetch` in use can actually serialize.
 *
 * Next.js polyfills globalThis.FormData with a Web API implementation that lacks
 * undici's internal symbols. Handed to undici's fetch, it falls back to
 * String(body) — "[object FormData]" sent as text/plain — so STT/image upstreams
 * answer 422/400 because the file and model fields are missing. Resolve undici's
 * own FormData once here and use it for every multipart request.
 */

type FormDataCtor = typeof FormData

async function resolveFormData(): Promise<FormDataCtor> {
	try {
		const undici = await import("undici")
		if (undici?.FormData) return undici.FormData as unknown as FormDataCtor
	} catch {
		// Lightweight harnesses omit undici: the global implementation is the best
		// available option there.
	}
	return globalThis.FormData
}

export const FormDataImpl: FormDataCtor = await resolveFormData()
