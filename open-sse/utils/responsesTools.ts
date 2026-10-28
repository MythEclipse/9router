import { MAX_TOOL_NAME_LEN } from "../config/runtimeConfig.ts";
import { clampResponsesCallId, coerceResponsesArguments, coerceResponsesOutput } from "../translator/formats/responsesApi.ts";

/**
 * Normalize OpenAI-style `tools` into the flat shape strict Responses backends
 * accept, mutating `body` in place.
 *
 * Accepts both `{type,function:{name,description,parameters}}` and the already
 * flattened `{type,name,description,parameters}` form, drops unusable entries,
 * and collects the surviving names so a `tool_choice` pointing at a removed tool
 * can be dropped too. Shared by the opencode-family executors, which all talk to
 * the same Responses API.
 */
export function normalizeResponsesTools(body: Record<string, any>) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set<string>();

  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;

    const description = typeof tool.description === "string"
      ? tool.description
      : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
        ? fn.parameters
        : { type: "object", properties: {} });

    // Mirror the request translator: {type:"object"} without properties is
    // rejected by strict Responses backends, so fill in the empty properties map.
    if (parameters.type === "object" && !parameters.properties) {
      parameters = { ...parameters, properties: {} };
    }

    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, MAX_TOOL_NAME_LEN);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(tool.name);
    return true;
  });

  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

/**
 * Drop and repair prior-turn `input` items that strict Responses backends reject,
 * mutating `body` in place.
 *
 * Reasoning items are stripped: their `encrypted_content` can only be decrypted
 * by the exact caller/account that issued it, and the opencode-family executors
 * rotate through public/pooled credentials. Under stateless mode (store=false)
 * OpenAI then rejects the dangling reference as "not found or was deleted", so
 * dropping the items outright is what lets multi-turn tool loops succeed.
 *
 * Function calls get a non-empty name and clamped call ids/arguments; call
 * outputs get the same id clamping plus coerced output.
 */
export function sanitizeResponsesItems(body: Record<string, any>) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item: any) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}
