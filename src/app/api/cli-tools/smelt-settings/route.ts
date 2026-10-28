
import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.ts";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { readConfigForWrite } from "@/lib/cliTools/configWrite";

export const dynamic = "force-dynamic";

/**
 * Smelt config.json — a flat file where this route owns exactly four keys and
 * deletes them on reset; anything else a user added is preserved.
 */
interface SmeltConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  _managedBy?: string;
  [key: string]: unknown;
}

const execAsync = promisify(exec);

const getSmeltConfigPath = () => path.join(os.homedir(), ".smelt", "config.json");
const getSmeltDir = () => path.dirname(getSmeltConfigPath());

const checkSmeltInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
    const command = isWindows ? "where smelt" : "which smelt";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getSmeltConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const has9RouterConfig = (settings) => {
  if (!settings) return false;
  return (
    settings._managedBy === "9router" ||
    (typeof settings.baseUrl === "string" && settings.baseUrl.length > 0 && settings.baseUrl.includes("20128"))
  );
};

const readConfig = async () => {
  try {
    const content = await fs.readFile(getSmeltConfigPath(), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
};

export async function GET() {
  try {
    const installed = await checkSmeltInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Smelt CLI is not installed",
      });
    }

    const config = await readConfig();

    return NextResponse.json({
      installed: true,
      config,
      has9Router: has9RouterConfig(config),
      configPath: getSmeltConfigPath(),
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

    const configPath = getSmeltConfigPath();
    await fs.mkdir(getSmeltDir(), { recursive: true });

    // An absent file means a fresh config; an unreadable one must abort the write
    // rather than let the merge below drop every other setting the user had.
    const existing: SmeltConfig = await readConfigForWrite(fs, configPath, (raw) =>
      JSON.parse(raw) as SmeltConfig
    );

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const updated: SmeltConfig = {
      ...existing,
      baseUrl: normalizedBaseUrl,
      apiKey: await resolveCliApiKey(apiKey),
      model: model || existing.model || "provider/model-id",
      _managedBy: "9router",
    };

    await fs.writeFile(configPath, JSON.stringify(updated, null, 2), "utf-8");

    return NextResponse.json({
      success: true,
      message: "Smelt settings applied successfully!",
      configPath,
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getSmeltConfigPath();
    let existing: SmeltConfig = {};
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      existing = JSON.parse(raw) as SmeltConfig;
    } catch {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    delete existing.baseUrl;
    delete existing.apiKey;
    delete existing.model;
    delete existing._managedBy;

    if (Object.keys(existing).length === 0) {
      await fs.rm(configPath, { force: true });
    } else {
      await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");
    }

    return NextResponse.json({ success: true, message: "Smelt 9Router settings removed" });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}
