// Shared SSE primitives (no imports → safe for executors + stream.js)
export const SSE_DONE = "data: [DONE]\n\n"

export const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
}

// Variant for web-cookie executors behind nginx (disable proxy buffering)
export const SSE_HEADERS_NO_BUFFER = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	"X-Accel-Buffering": "no",
}

// Variant for client-facing SSE responses (adds permissive CORS)
export const SSE_HEADERS_CORS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
	"Access-Control-Allow-Origin": "*",
	// Every byte the client sees must leave as it is produced. Without this a
	// reverse proxy (nginx, Caddy behind an nginx ingress, a CDN) is free to
	// buffer the whole response and hand it over at the end - which is
	// indistinguishable from the gateway collecting the answer first, and was
	// reported exactly that way. `no` opts this response out of proxy buffering;
	// it is the response-side counterpart to `proxy_buffering off`.
	"X-Accel-Buffering": "no",
}

// Wire primitives, so no module has to retype them.
export const SSE_DATA_PREFIX = "data:"
export const SSE_DONE_DATA = "[DONE]"
export const SSE_CONTENT_TYPE_EVENT_STREAM = "text/event-stream"
export const SSE_CONTENT_TYPE_JSON = "application/json"
