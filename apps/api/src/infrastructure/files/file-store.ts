/**
 * The file store, backed by the `kv` table.
 *
 * A thin adapter on purpose: `filesRepo` owns the encoding, and the use-case owns the rules.
 * What lives here is the one thing neither of them can decide — that a metadata row read back
 * from storage is only a `FileMeta` if it has an id, so a hand-edited row cannot become a file
 * with `undefined` for a name.
 */
import { deleteFile, getFile, listFiles, putFile } from "@9router/db/repos/filesRepo"
import type { FileStore } from "../../application/files/files.ts"

export function fileStore(): FileStore {
	return {
		put: putFile,
		get: getFile,
		list: listFiles,
		remove: deleteFile,
	}
}
