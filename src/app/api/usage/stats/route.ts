import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";
import { getSessionContext } from "@/lib/auth/dashboardPermissions";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const ctx = await getSessionContext();
    // Narrowed locally: the session payload fields are typed `unknown`, but the
    // filter is a key string or null and the model scope is always a string.
    const apiKeyFilter = typeof ctx.apiKeyFilter === "string" ? ctx.apiKeyFilter : null;
    const allowedModels = typeof ctx.allowedModels === "string" ? ctx.allowedModels : "*";
    const stats = await getUsageStats(period, apiKeyFilter, allowedModels);
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
