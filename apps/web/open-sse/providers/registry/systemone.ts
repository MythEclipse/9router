// System One (Google) — the `decisions` lane on generativelanguage.googleapis.com.
//
// Same protocol as the other System One lanes (nace, ollama, opencode): a state plus
// typed questions (noul / choice / score) in, calibrated answers out, and the JSON reply
// is forwarded untouched so `probability`, `confidence` and any `legend` reach the client
// as Google returns them. Two wire details differ from nace/ollama, and both are declared
// in systemoneConfig rather than special-cased in the handler:
//
//   - the API key rides `x-goog-api-key`; Google rejects a key sent as
//     `Authorization: Bearer` (authHeader names the header instead of "bearer")
//   - the state is called `input`, not `state` (stateField renames it on the way out;
//     the router's own /v1/systemone endpoint accepts either name)
//
// Catalogue is hand-written: the decisions lane exposes `gemini-decision-1` and there is
// no unauthenticated model listing for it, so a modelsFetcher would only render an error.
const Systemone = {
	id: "systemone",
	// After every existing decision lane (ollama 30, opencode 40, nace 48, cloudflare 60):
	// pickDecisionReviewTarget prefers the lowest priority, and adding a paid keyed lane
	// must not silently take over safeguards reviews on installs that never configured it.
	priority: 65,
	alias: "systemone",
	aliases: ["system-one", "gdecision", "gemini-decision"],
	uiAlias: "systemone",
	display: {
		name: "System One (Google)",
		icon: "psychology",
		color: "#4285F4",
		textIcon: "S1",
		website: "https://ai.google.dev/gemini-api/docs",
		notice: {
			text:
				"Google's decision lane on the System One protocol (noul / choice questions, calibrated probabilities). Paste a Google AI Studio API key (sent as x-goog-api-key). Upstream calls the state `input`; 9router accepts `state` or `input` and renames it on the way out.",
			apiKeyUrl: "https://aistudio.google.com/apikey",
		},
	},
	category: "apikey",
	authType: "apikey",
	models: [{ id: "gemini-decision-1", name: "Gemini Decision 1", kind: "systemone" }],
	serviceKinds: ["systemone"],
	systemoneConfig: {
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/decisions",
		// A saved host (providerSpecificData.baseUrl) is joined with this path.
		path: "/v1beta/decisions",
		authType: "apikey",
		authHeader: "x-goog-api-key",
		stateField: "input",
	},
}

export default Systemone
