import { resolveOllamaLocalHost } from "../../config/providers";

const ollamaLocalEmbedding = {
  buildUrl: (_model, credentials) => {
    const host = String(resolveOllamaLocalHost(credentials))
      .replace(/\/+$/, "")
      .replace(/\/v1\/embeddings$/, "")
      .replace(/\/v1$/, "");
    return `${host}/v1/embeddings`;
  },
  buildHeaders: (credentials) => ({
    "Content-Type": "application/json",
    ...(credentials?.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}),
  }),
  buildBody: (model, { input, encoding_format, dimensions }) => ({
    model,
    input,
    ...(encoding_format ? { encoding_format } : {}),
    ...(Number.isFinite(Number(dimensions)) && Number(dimensions) > 0
      ? { dimensions: Number(dimensions) }
      : {}),
  }),
  normalize: (responseBody) => responseBody,
};

export default ollamaLocalEmbedding;
