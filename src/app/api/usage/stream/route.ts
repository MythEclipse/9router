import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";
import { getSessionContext } from "@/lib/auth/dashboardPermissions";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const encoder = new TextEncoder();
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "today";

  const ctx = await getSessionContext();
  // Narrowed locally: the session payload fields are typed `unknown`, but the
  // filter is a key string or null and the model scope is always a string.
  const apiKeyFilter = typeof ctx.apiKeyFilter === "string" ? ctx.apiKeyFilter : null;
  const allowedModels = typeof ctx.allowedModels === "string" ? ctx.allowedModels : "*";

  const state = { closed: false, keepalive: null, send: null, sendPending: null, cachedStats: null, lastFullSignature: null };

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
          // The aggregates are a large map (one bucket per model, account, key and
          // endpoint). A finished request changes one bucket, but re-sending the
          // whole map forced the dashboard to rebuild and re-render every table
          // several times a second — the page looked like it was flickering. Send
          // it only when its totals actually move; the frame above already carried
          // this request's live row.
          const signature = `${stats.totalRequests}|${stats.totalPromptTokens}|${stats.totalCompletionTokens}|${stats.totalCost}`;
          if (signature === state.lastFullSignature) return;
          state.lastFullSignature = signature;
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
