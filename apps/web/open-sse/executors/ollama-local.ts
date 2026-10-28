import { resolveOllamaLocalHost } from "../config/providers.ts"
import { DefaultExecutor } from "./default.ts"

export class OllamaLocalExecutor extends DefaultExecutor {
	constructor() {
		super("ollama-local")
	}

	buildUrl(_model, _stream, _urlIndex = 0, credentials = null) {
		return `${resolveOllamaLocalHost(credentials)}/api/chat`
	}
}

export default OllamaLocalExecutor
