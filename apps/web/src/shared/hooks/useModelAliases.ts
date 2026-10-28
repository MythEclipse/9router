"use client"

import { useCallback, useEffect, useState } from "react"

// Module cache: one /api/models/alias fetch shared by every card that needs the
// alias table, instead of one request per mounted tool card.
let cache = null
let inflight = null

function loadModelAliases() {
	if (cache) return Promise.resolve(cache)
	if (inflight) return inflight
	inflight = fetch("/api/models/alias")
		.then(async (res) => {
			if (!res.ok) return {}
			const data = await res.json()
			cache = data.aliases || {}
			return cache
		})
		.catch((error) => {
			console.log("Error fetching model aliases:", error)
			// Keep the cache empty-but-nullable so a later mount can retry.
			cache = null
			return {}
		})
		.finally(() => {
			inflight = null
		})
	return inflight
}

/** Drop the shared alias cache so the next mount refetches. */
export function invalidateModelAliases() {
	cache = null
}

/**
 * The model alias table (`alias → provider/model`), fetched once per page load.
 * `refresh` forces a refetch, for callers that change aliases.
 */
export function useModelAliases() {
	const [modelAliases, setModelAliases] = useState(() => cache || {})

	useEffect(() => {
		let alive = true
		loadModelAliases().then((aliases) => {
			if (alive) setModelAliases(aliases)
		})
		return () => {
			alive = false
		}
	}, [])

	const refresh = useCallback(async () => {
		invalidateModelAliases()
		const aliases = await loadModelAliases()
		setModelAliases(aliases)
	}, [])

	return { modelAliases, refresh }
}
