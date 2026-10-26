import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";
import { getSessionContext } from "@/lib/auth/dashboardPermissions";
import { parseAllowedModels } from "@/lib/db/repos/allowedModels";
import { getSettings } from "@/lib/db/repos/settingsRepo";
import { isAuthenticated } from "@/dashboardGuard";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate
 *
 * Payload redaction
 * -----------------
 * The stored details contain full request bodies (user prompts, tool calls) and
 * provider responses. Returning them to every dashboard-authenticated user — or,
 * with requireLogin disabled, to anyone who can reach the port — turns the
 * observability tab into a conversation-history reader for all traffic through
 * the gateway. So `request` / `providerRequest` / `providerResponse` / `response`
 * are withheld by default and only returned when the operator turns on
 * `observabilityIncludePayloads`.
 *
 * The redaction is explicit rather than silent: each withheld field carries a
 * marker saying it was withheld and how to see it, because a bare
 * `{redacted:true}` reads as "this request had no payload" and sends people
 * hunting for a storage bug that isn't there.
 */
function withheldMarker(field: string, revealed: unknown) {
  return {
    withheld: true,
    field,
    bytes: revealed == null ? 0 : JSON.stringify(revealed).length,
    hint: "Payload hidden. Enable Settings → Observability → include payloads to view request/response bodies.",
  };
}

export async function GET(request: Request) {
  try {
    // An API-key session may only see requests for the models its key allows, so
    // the listing is narrowed before any user-supplied filter is applied.
    const ctx = await getSessionContext();
    const allowedModelPatterns = parseAllowedModels(ctx.allowedModels || "*");
    const { searchParams } = new URL(request.url);

    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    if (page < 1) {
      return NextResponse.json({ error: "Page must be >= 1" }, { status: 400 });
    }

    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json({ error: "PageSize must be between 1 and 100" }, { status: 400 });
    }

    const filter: {
      page: number;
      pageSize: number;
      allowedModelPatterns: string[];
      provider?: string;
      model?: string;
      connectionId?: string;
      status?: string;
      startDate?: string;
      endDate?: string;
    } = {
      page,
      pageSize,
      allowedModelPatterns,
    };

    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;

    const result = await getRequestDetails(filter);

    let includePayloads = false;
    try {
      const settings = await getSettings();
      includePayloads = settings?.observabilityIncludePayloads === true;
      // A gateway with login disabled serves /api/usage/* to anyone who can reach
      // the port, so payloads there would be world-readable conversation history.
      // Withhold unless the request is authenticated even though login is off.
      if (includePayloads && settings?.requireLogin === false) {
        includePayloads = await isAuthenticated(request);
      }
    } catch {
      // Fail closed: an unreadable settings row must not reveal payloads.
      includePayloads = false;
    }

    const PAYLOAD_FIELDS = ["request", "providerRequest", "providerResponse", "response"];
    const details = (result.details || []).map((d) => {
      if (includePayloads) return d;
      const out = { ...d };
      for (const key of PAYLOAD_FIELDS) {
        if (out[key] !== undefined) out[key] = withheldMarker(key, out[key]);
      }
      return out;
    });

    return NextResponse.json({
      ...result,
      details,
      payloadsIncluded: includePayloads,
    });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json({ error: "Failed to fetch request details" }, { status: 500 });
  }
}
