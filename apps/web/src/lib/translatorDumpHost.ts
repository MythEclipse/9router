/**
 * The translator inspector's dump folder.
 *
 * `logs/translator` sits under the running process's working directory, so this is host work: the
 * API package cannot know where the dashboard was started from. Both methods take an
 * already-validated name — `translatorDumpFile` runs before they are called — and this file still
 * joins rather than concatenates so a stray separator cannot escape the folder.
 */
import fs from "node:fs"
import path from "node:path"
import type { TranslatorDumpStore } from "9router-api/application/translator/read-translator-dumps"

const dir = (): string => path.join(process.cwd(), "logs", "translator")

export const translatorDumpStore: TranslatorDumpStore = {
	read: (file) => {
		const filePath = path.join(dir(), file)
		return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null
	},
	write: (file, content) => {
		const folder = dir()
		fs.mkdirSync(folder, { recursive: true })
		fs.writeFileSync(path.join(folder, file), content, "utf-8")
	},
}
