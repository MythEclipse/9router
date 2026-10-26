import { resolveOllamaLocalHost } from "../../config/providers";
import { responseToBase64, throwUpstreamError } from "./_base";

const DEFAULT_MODEL = "phonon:multilingual";
const DEFAULT_VOICE = "default";

function resolveModelAndVoice(model) {
  if (!model) return { modelId: DEFAULT_MODEL, voiceId: DEFAULT_VOICE };
  const [modelId, ...voiceParts] = String(model).split("/").filter(Boolean);
  if (voiceParts.length) return { modelId, voiceId: voiceParts.join("/") };
  return modelId.startsWith("phonon")
    ? { modelId, voiceId: DEFAULT_VOICE }
    : { modelId: DEFAULT_MODEL, voiceId: modelId };
}

const ollamaLocalTts = {
  async synthesize(text, model, credentials, responseFormat = "mp3") {
    const host = String(resolveOllamaLocalHost(credentials))
      .replace(/\/+$/, "")
      .replace(/\/v1\/audio\/speech$/, "")
      .replace(/\/v1$/, "");
    const { modelId, voiceId } = resolveModelAndVoice(model);
    const upstreamFormat = responseFormat === "pcm" ? "pcm" : "wav";
    const headers = {
      "Content-Type": "application/json",
      ...(credentials?.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}),
    };
    const url = `${host}/v1/audio/speech`;
    const payload = { model: modelId, input: text, voice: voiceId, response_format: upstreamFormat };

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (error?.cause?.code === "ECONNREFUSED" || error?.code === "ECONNREFUSED" || error?.message?.includes("fetch failed")) {
        throw new Error(`Cannot connect to Ollama at ${host}. Please ensure Ollama is running (e.g. 'ollama serve').`);
      }
      throw error;
    }

    if (!response.ok && response.status === 404 && modelId.startsWith("phonon")) {
      const tagsResponse = await fetch(`${host}/api/tags`).catch(() => null);
      let alternative = null;
      if (tagsResponse?.ok) {
        try {
          const data = await tagsResponse.json();
          const installed = (data.models || []).map((entry) => entry.name || entry.model).filter(Boolean);
          alternative = installed.find((entry) => entry.startsWith("phonon") && entry !== modelId) || null;
        } catch {
          alternative = null;
        }
      }
      if (!alternative) {
        alternative = modelId === "phonon" ? "phonon:multilingual"
          : modelId === "phonon:multilingual" ? "phonon:latest"
          : null;
      }
      if (alternative) {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...payload, model: alternative }),
        });
      }
    }

    if (!response.ok && response.status === 400 && voiceId !== DEFAULT_VOICE) {
      const message = await response.clone().text();
      if (message.includes("voice") && message.includes("not found")) {
        const retry = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...payload, voice: DEFAULT_VOICE }),
        });
        if (retry.ok) response = retry;
      }
    }

    if (!response.ok) await throwUpstreamError(response);
    return responseToBase64(response, upstreamFormat);
  },
};

export default ollamaLocalTts;
