import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";
import { getSessionContext } from "@/lib/auth/dashboardPermissions";

export const dynamic = "force-dynamic";

// Cap how often the whole aggregate map is pushed. Aggregates are a summary —
// 2s stale is imperceptible, while re-sending them per request (~5/s under load)
// re-rendered every table reading them and made the page flash continuously.
const FULL_FRAME_MIN_INTERVAL_MS = 2000;

export async function GET(request) {
  const encoder = new TextEncoder();
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "today";

  const ctx = await getSessionContext();
  // Narrowed locally: the session payload fields are typed `unknown`, but the
  // filter is a key string or null and the model scope is always a string.
  const apiKeyFilter = typeof ctx.apiKeyFilter === "string" ? ctx.apiKeyFilter : null;
  const allowedModels = typeof ctx.allowedModels === "string" ? ctx.allowedModels : "*";

  const state = { closed: false, keepalive: null, send: null, sendPending: null, cachedStats: null, lastFullAt: 0 };

  const stream = new ReadableStream({
    async start(controller) {
      state.send = async () => {
        if (state.closed) return;
        try {
          // allowedModels is not optional here: this stream is the second source the
          // Usage page merges in, and omitting it silently widens the scope to every
          // model, which is what let unrelated providers show up under an API-key login.
          const stats = await getUsageStats(period, apiKeyFilter, allowedModels);
          state.cachedStats = stats;
          // The live rows ride on every frame and are cheap (20 entries), so they go
          // out regardless — the table must keep moving even when the aggregates
          // below are suppressed. Deliberately NOT spreading `stats` into this
          // frame: the client merges these four keys into what it already has, and
          // shipping the aggregate map twice per tick is what made the page flicker.
          const { activeRequests, recentRequests, errorProvider } = await getActiveRequests(apiKeyFilter, allowedModels);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ activeRequests, recentRequests, errorProvider, pending: stats.pending ?? null, _type: "pending" })}\n\n`));
          // The aggregate map is large (one bucket per model, account, key and
          // endpoint) and a finished request changes exactly one bucket. Under
          // real load this route fires ~5 times a second, so re-sending the whole
          // map re-rendered every table reading it and the page never sat still.
          // Totals move on every request, so comparing them dedupes nothing —
          // pace the frame by wall-clock instead. Aggregates are a summary; being
          // up to FULL_FRAME_MIN_INTERVAL_MS stale is invisible, five re-renders a
          // second is not.
          const now = Date.now();
          if (now - state.lastFullAt < FULL_FRAME_MIN_INTERVAL_MS) return;
          state.lastFullAt = now;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...stats, _type: "full" })}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.sendPending);
          clearInterval(state.keepalive);
        }
      };

      state.sendPending = async () => {
        if (state.closed || !state.cachedStats) return;
        try {
          const { activeRequests, recentRequests, errorProvider } = await getActiveRequests(apiKeyFilter, allowedModels);
          const stats = { activeRequests, recentRequests, errorProvider, pending: state.cachedStats.pending ?? null, _type: "pending" };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.sendPending);
          clearInterval(state.keepalive);
        }
      };

      await state.send();

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.sendPending);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.closed = true;
          clearInterval(state.keepalive);
        }
      }, 25000);
    },

    cancel() {
      state.closed = true;
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.sendPending);
      clearInterval(state.keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
