
import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { resolveModelDisplayName } from "@/shared/utils/modelDisplayName";

export const dynamic = "force-dynamic";

/** One model entry inside a Pi provider block. */
interface PiModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  [key: string]: unknown;
}

/** One entry of the `providers` map in Pi's models.json. */
interface PiProvider {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  models?: Array<PiModel | string>;
  [key: string]: unknown;
}

/** Pi models.json — this route only owns `providers["9router"]`. */
interface PiSettings {
  providers?: Record<string, PiProvider>;
  [key: string]: unknown;
}

const execAsync = promisify(exec);
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

function normalizePiLimit(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

const getPiModelsJsonPath = () => {
  const agentPath = path.join(os.homedir(), ".pi", "agent", "models.json");
  return agentPath;
};

const getPiDir = () => path.dirname(getPiModelsJsonPath());

const checkPiInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
    const command = isWindows ? "where pi" : "which pi";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getPiModelsJsonPath());
      return true;
    } catch {
      try {
        await fs.access(path.join(os.homedir(), ".pi", "models.json"));
        return true;
      } catch {
        return false;
      }
    }
  }
};

const has9RouterConfig = (settings): boolean => {
  if (!settings || !settings.providers) return false;
  const p = settings.providers["9router"];
  if (p && p.baseUrl) return true;
  for (const prov of Object.values(settings.providers) as PiProvider[]) {
    if (typeof prov?.baseUrl === "string" && prov.baseUrl.includes("20128")) {
      return true;
    }
  }
  return false;
};

const resolveModelsJsonPath = async () => {
  const agentPath = path.join(os.homedir(), ".pi", "agent", "models.json");
  const rootPath = path.join(os.homedir(), ".pi", "models.json");
  try {
    await fs.access(agentPath);
    return agentPath;
  } catch {
    try {
      await fs.access(rootPath);
      return rootPath;
    } catch {
      return agentPath;
    }
  }
};

const readConfig = async () => {
  try {
    const targetPath = await resolveModelsJsonPath();
    const content = await fs.readFile(targetPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
};

export async function GET() {
  try {
    const installed = await checkPiInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Pi CLI is not installed",
      });
    }

    const config = await readConfig();
    const configPath = await resolveModelsJsonPath();

    return NextResponse.json({
      installed: true,
      config,
      has9Router: has9RouterConfig(config),
      configPath,
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  try {
    const { baseUrl, apiKey, model } = rawBody || {};
    if (!baseUrl) {
      return NextResponse.json({ error: { message: "baseUrl is required" } }, { status: 400 });
    }

    const configPath = await resolveModelsJsonPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    let existing: PiSettings = {};
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      existing = JSON.parse(raw) as PiSettings;
    } catch {
      /* No existing config */
    }

    if (!existing.providers) existing.providers = {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const existingProvider = existing.providers["9router"] || {};
    const previousModels = new Map<string, Partial<PiModel>>();
    for (const entry of Array.isArray(existingProvider.models) ? existingProvider.models : []) {
      if (typeof entry === "string") previousModels.set(entry, { id: entry });
      else if (typeof entry?.id === "string") previousModels.set(entry.id, entry);
    }
    const buildModel = (requested: unknown): PiModel => {
      const modelData: Partial<PiModel> = typeof requested === "string"
        ? { id: requested }
        : (requested && typeof requested === "object" ? requested as Partial<PiModel> : {});
      const id = typeof modelData.id === "string" && modelData.id ? modelData.id : "provider/model-id";
      const previous = previousModels.get(id) || {};
      const requestedName = typeof modelData.name === "string" && modelData.name !== id
        ? modelData.name
        : previous.name;
      return {
        ...previous,
        ...modelData,
        id,
        name: resolveModelDisplayName(id, requestedName),
        contextWindow: normalizePiLimit(modelData.contextWindow ?? previous.contextWindow, DEFAULT_CONTEXT_WINDOW, 2000000),
        maxTokens: normalizePiLimit(modelData.maxTokens ?? previous.maxTokens, DEFAULT_MAX_TOKENS, 200000),
      };
    };

    let modelList: PiModel[] = [];
    if (Array.isArray(rawBody.models) && rawBody.models.length > 0) {
      modelList = rawBody.models.map(buildModel);
    } else {
      modelList = [buildModel(model || "provider/model-id")];
    }

    const requestedApiKey = typeof apiKey === "string" && apiKey.trim() && apiKey !== "sk_9router"
      ? apiKey
      : null;
    const resolvedApiKey = requestedApiKey
      || await resolveCliApiKey(null)
      || existingProvider.apiKey;

    existing.providers["9router"] = {
      ...existingProvider,
      baseUrl: normalizedBaseUrl,
      apiKey: resolvedApiKey,
      api: existingProvider.api || "openai-completions",
      models: modelList,
    };

    await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");

    return NextResponse.json({
      success: true,
      message: "Pi settings applied! Use /model in Pi to select the 9Router model.",
      configPath,
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = await resolveModelsJsonPath();
    let existing: PiSettings = {};
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      existing = JSON.parse(raw) as PiSettings;
    } catch {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    if (existing.providers && existing.providers["9router"]) {
      delete existing.providers["9router"];
      if (Object.keys(existing.providers).length === 0) delete existing.providers;
      await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");
    }

    return NextResponse.json({ success: true, message: "9Router removed from Pi" });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}
