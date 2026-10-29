import { invalid } from "../../domain/errors.ts"
import {
	accountsOf,
	type BulkImportAnswer,
	strippedAccount,
	withImportDefaults,
} from "../../domain/oauth-import.ts"

/**
 * Importing a batch of provider credentials.
 *
 * One use-case for every provider that takes a pasted token list, because the batch rules
 * are identical: normalize the body, strip what the server owns, fill in the defaults an
 * OAuth flow would have set, and insert one row per account. What differs per provider is
 * how a token's claims are read — that is `backfill`, injected.
 */

export interface BulkImportDeps {
	/** Fill identity fields the caller left blank, from the token's own claims. */
	readonly backfill: (item: Record<string, unknown>) => Record<string, unknown>
	/** Insert one connection and answer its id. */
	readonly create: (input: Record<string, unknown>) => Promise<{ id: string }>
	readonly now: () => number
}

/**
 * `POST /api/oauth/<provider>/bulk-import` — { accounts: [...] } or a bare array.
 *
 * A row that fails does not stop the batch: the operator pasted a list, and answering
 * "failed" for the whole list because line 7 is malformed would make them fix it blind.
 * The per-row reason is what lets them fix line 7.
 *
 * The loop is serial on purpose — see `BULK_IMPORT_IS_SERIAL`.
 */
export async function importCredentialBatch(
	input: { readonly provider: string; readonly authType: string; readonly body: unknown },
	deps: BulkImportDeps,
): Promise<BulkImportAnswer> {
	const accounts = accountsOf(input.body)
	if (!accounts || accounts.length === 0) throw invalid("No accounts provided")

	const now = deps.now()
	const results: BulkImportAnswer["results"][number][] = []
	let success = 0
	let failed = 0

	for (let index = 0; index < accounts.length; index += 1) {
		const stripped = strippedAccount(accounts[index])
		if (stripped.error !== undefined) {
			results.push({ index, ok: false, error: stripped.error })
			failed += 1
			continue
		}

		try {
			const item = withImportDefaults(deps.backfill(stripped.account), now)
			const created = await deps.create({
				provider: input.provider,
				authType: input.authType,
				...item,
			})
			results.push({ index, ok: true, id: created.id })
			success += 1
		} catch (error) {
			results.push({
				index,
				ok: false,
				error: error instanceof Error ? error.message : "Unknown error",
			})
			failed += 1
		}
	}

	return { success, failed, results }
}
