import {
  KIRO_TOOL_DESCRIPTION_MAX_LENGTH,
  KIRO_TOOL_ID_MAX_LENGTH,
  KIRO_TOOL_NAME_MAX_LENGTH,
} from "../../config/kiroConstants";

/**
 * Kiro wire shapes, shared with the request translators that build them.
 *
 * The conversation is a strict alternation of user/assistant turns; a turn
 * carries exactly one of the two message keys.
 */
export interface KiroToolResult {
  toolUseId: string;
  status: "success" | "error";
  content: { text: string }[];
}

export interface KiroToolUse {
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface KiroUserInputContext {
  toolResults?: KiroToolResult[];
  tools?: KiroToolSpec[];
}

export interface KiroUserInputMessage {
  content: string;
  modelId?: string;
  /** Set by the translators ("AI_EDITOR"); Kiro echoes it back on the wire. */
  origin?: string;
  images?: { format: string; source: { bytes: string } }[];
  userInputMessageContext?: KiroUserInputContext;
}

export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
}

export interface KiroTurn {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
}

export interface KiroToolSpec {
  toolSpecification?: {
    name?: string;
    description?: string;
    inputSchema?: { json?: unknown };
  };
}

/** `GenerateAssistantResponse` request body as built by the request translators. */
export interface KiroPayload {
  conversationState: {
    chatTriggerType: string;
    conversationId: unknown;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history: KiroTurn[];
  };
  profileArn?: unknown;
  additionalModelRequestFields?: unknown;
  inferenceConfig?: { maxTokens?: unknown; temperature?: unknown; topP?: unknown };
  /** Internal reverse tool-name map (non-enumerable marker `_kiroUpstreamModel` is separate). */
  _toolNameMap?: Map<string, string>;
}

/** Tool spec as accepted from either OpenAI (`function`) or Claude (`name`) shape. */
interface KiroToolDefinition {
  name?: string;
  description?: string;
  parameters?: unknown;
  input_schema?: unknown;
  function?: { name?: string; description?: string; parameters?: unknown };
}

const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Kiro rejects user turns with empty `content`, so a turn that only carries
 * tool results needs placeholder text. It must not read like a user
 * instruction: with "continue", models answer the word itself ("Nothing in
 * progress to continue") and drop the task they were in the middle of.
 */
export const KIRO_TOOL_RESULTS_PLACEHOLDER = "Tool results provided.";
export const KIRO_EMPTY_USER_PLACEHOLDER = "continue";

/** Placeholder content for a user turn with no text of its own. */
export function kiroEmptyUserContent(hasToolResults: boolean) {
  return hasToolResults ? KIRO_TOOL_RESULTS_PLACEHOLDER : KIRO_EMPTY_USER_PLACEHOLDER;
}
const TOOL_NAME_PATTERN = /[^a-zA-Z0-9_-]/g;

/** Loosely-typed JSON Schema node - the canonicalizer only touches these keys. */
export interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function appendText(target: { content?: string }, extra?: string) {
  if (!extra) return;
  target.content = target.content ? `${target.content}\n\n${extra}` : extra;
}

function trimCodePoints(value: unknown, limit: number) {
  return [...String(value || "")].slice(0, limit).join("");
}

function uniqueName(rawName: unknown, index: number, usedNames: Set<string>) {
  const cleaned = String(rawName || "")
    .trim()
    .replace(TOOL_NAME_PATTERN, "_")
    .replace(/^_+|_+$/g, "");
  const base = trimCodePoints(cleaned || `tool_${index + 1}`, KIRO_TOOL_NAME_MAX_LENGTH);
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    const tail = `_${suffix++}`;
    candidate = `${base.slice(0, KIRO_TOOL_NAME_MAX_LENGTH - tail.length)}${tail}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function cleanSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchemaValue);
  if (!value || typeof value !== "object") return value;

  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "additionalProperties") continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    cleaned[key] = cleanSchemaValue(child);
  }
  return cleaned;
}

function normalizeRootSchema(schema: unknown): JsonSchemaNode {
  const cleaned = cleanSchemaValue(schema && typeof schema === "object" ? clone(schema) : {}) as JsonSchemaNode;
  cleaned.type = "object";
  if (!cleaned.properties || typeof cleaned.properties !== "object" || Array.isArray(cleaned.properties)) {
    cleaned.properties = {};
  }
  if (Array.isArray(cleaned.required)) {
    cleaned.required = [...new Set(cleaned.required.filter(
      (name) => typeof name === "string" && Object.hasOwn(cleaned.properties as object, name)
    ))];
    if (cleaned.required.length === 0) delete cleaned.required;
  }
  return cleaned;
}

/** Normalize OpenAI- or Claude-shaped tool definitions into Kiro tool specs. */
export function normalizeKiroToolSpecs(tools: unknown) {
  const specs: KiroToolSpec[] = [];
  const nameMap = new Map<string, string>();
  const usedNames = new Set<string>();

  for (const [index, tool] of (Array.isArray(tools) ? (tools as KiroToolDefinition[]) : []).entries()) {
    if (!tool || typeof tool !== "object") continue;
    const rawName = tool.function?.name ?? tool.name;
    if (typeof rawName !== "string" || !rawName.trim()) continue;

    // A repeated definition with the same source name describes the same tool.
    if (nameMap.has(rawName)) continue;
    const name = uniqueName(rawName, index, usedNames);
    nameMap.set(rawName, name);

    const rawDescription = tool.function?.description ?? tool.description ?? `Tool: ${rawName}`;
    const description = trimCodePoints(
      String(rawDescription || `Tool: ${rawName}`),
      KIRO_TOOL_DESCRIPTION_MAX_LENGTH
    );
    const schema = tool.function?.parameters ?? tool.parameters ?? tool.input_schema ?? {};
    specs.push({
      toolSpecification: {
        name,
        description,
        inputSchema: { json: normalizeRootSchema(schema) },
      },
    });
  }

  return { specs, nameMap };
}

function toolCallText(toolUse: { name?: unknown; input?: unknown } | undefined) {
  return `[Tool call: ${toolUse?.name || "unknown"}(${text(toolUse?.input || {})})]`;
}

function toolResultText(toolResult: unknown) {
  const result = toolResult as { content?: unknown; status?: unknown } | null | undefined;
  const content = Array.isArray(result?.content)
    ? result.content.map((part) => text((part as { text?: unknown })?.text ?? part)).filter(Boolean).join("\n")
    : text(result?.content);
  return `[Tool result${result?.status === "error" ? " (error)" : ""}: ${content}]`;
}

function mergeUser(target: KiroUserInputMessage, source: KiroUserInputMessage) {
  appendText(target, source.content);
  if (Array.isArray(source.images) && source.images.length > 0) {
    target.images = [...(target.images || []), ...source.images];
  }
  const results = source.userInputMessageContext?.toolResults;
  if (Array.isArray(results) && results.length > 0) {
    target.userInputMessageContext ||= {};
    target.userInputMessageContext.toolResults = [
      ...(target.userInputMessageContext.toolResults || []),
      ...results,
    ];
  }
}

function mergeAssistant(target: KiroAssistantResponseMessage, source: KiroAssistantResponseMessage) {
  appendText(target, source.content);
  if (Array.isArray(source.toolUses) && source.toolUses.length > 0) {
    target.toolUses = [...(target.toolUses || []), ...source.toolUses];
  }
}

function normalizeTurns(history: unknown, currentMessage: unknown, modelId: string): KiroTurn[] {
  const rawTurns: KiroTurn[] = [...(Array.isArray(history) ? (history as KiroTurn[]) : [])];
  if (currentMessage) rawTurns.push(currentMessage as KiroTurn);
  const turns: KiroTurn[] = [];

  for (const raw of rawTurns) {
    const isUser = !!raw?.userInputMessage;
    const isAssistant = !!raw?.assistantResponseMessage;
    if (isUser === isAssistant) continue;

    const turn: KiroTurn = isUser
      ? { userInputMessage: clone(raw.userInputMessage) }
      : { assistantResponseMessage: clone(raw.assistantResponseMessage) };
    const previous = turns[turns.length - 1];
    if (turn.userInputMessage && previous?.userInputMessage) {
      mergeUser(previous.userInputMessage, turn.userInputMessage);
    } else if (turn.assistantResponseMessage && previous?.assistantResponseMessage) {
      mergeAssistant(previous.assistantResponseMessage, turn.assistantResponseMessage);
    } else {
      turns.push(turn);
    }
  }

  if (turns[0]?.assistantResponseMessage) {
    turns.unshift({ userInputMessage: { content: "continue", modelId } });
  }
  if (turns.length === 0 || turns[turns.length - 1]?.assistantResponseMessage) {
    turns.push({ userInputMessage: { content: "continue", modelId } });
  }

  for (const turn of turns) {
    if (turn.userInputMessage) {
      turn.userInputMessage.content = text(turn.userInputMessage.content).trim()
        || kiroEmptyUserContent((turn.userInputMessage.userInputMessageContext?.toolResults?.length ?? 0) > 0);
      turn.userInputMessage.modelId ||= modelId;
      if (turn.userInputMessage.userInputMessageContext?.tools) {
        delete turn.userInputMessage.userInputMessageContext.tools;
      }
    } else if (turn.assistantResponseMessage) {
      turn.assistantResponseMessage.content =
        text(turn.assistantResponseMessage.content).trim() || "...";
    }
  }
  return turns;
}

function rawId(value: unknown) {
  return typeof value === "string" ? value : "";
}

function reserveToolId(value: unknown, turnIndex: number, callIndex: number, name: unknown, usedIds: Set<string>) {
  const sanitized = rawId(value).replace(/[^a-zA-Z0-9_-]/g, "");
  const generated = `call_msg${turnIndex}_tc${callIndex}_${name || "tool"}`;
  const base = trimCodePoints(
    TOOL_ID_PATTERN.test(sanitized) && sanitized ? sanitized : generated,
    KIRO_TOOL_ID_MAX_LENGTH
  );
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    const tail = `_${suffix++}`;
    candidate = `${base.slice(0, KIRO_TOOL_ID_MAX_LENGTH - tail.length)}${tail}`;
  }
  usedIds.add(candidate);
  return candidate;
}

function normalizeToolInput(input: unknown) {
  if (input && typeof input === "object" && !Array.isArray(input)) return clone(input);
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return input == null ? {} : null;
}

function normalizeToolResult(result: unknown): KiroToolResult {
  const raw = result as { content?: unknown; toolUseId?: unknown; status?: unknown } | null | undefined;
  const content = Array.isArray(raw?.content)
    ? raw.content.map((part) => ({ text: text((part as { text?: unknown })?.text ?? part) }))
    : [{ text: text(raw?.content) }];
  return {
    toolUseId: rawId(raw?.toolUseId),
    status: raw?.status === "error" ? "error" : "success",
    content: content.length > 0 ? content : [{ text: "" }],
  };
}

function flattenResults(userMessage: KiroUserInputMessage, results: unknown[]) {
  for (const result of results) appendText(userMessage, toolResultText(result));
}

function cleanUserContext(userMessage: KiroUserInputMessage) {
  const context = userMessage.userInputMessageContext;
  if (!context) return;
  if (!context.toolResults?.length) delete context.toolResults;
  if (!context.tools?.length) delete context.tools;
  if (Object.keys(context).length === 0) delete userMessage.userInputMessageContext;
}

/** Repair counters reported back to the caller. */
interface KiroRepairs {
  missingResults: number;
  orphanResults: number;
  invalidToolUses: number;
}

interface KiroCallRecord {
  call: KiroToolUse;
  callIndex: number;
  key: string;
  mappedName: unknown;
  input: unknown;
  result: KiroToolResult | null;
}

function reconcileToolPair(
  assistant: KiroAssistantResponseMessage,
  user: KiroUserInputMessage,
  turnIndex: number,
  nameMap: Map<string, string>,
  specNames: Set<string>,
  usedIds: Set<string>,
  repairs: KiroRepairs,
) {
  const calls: KiroToolUse[] = Array.isArray(assistant.toolUses) ? assistant.toolUses : [];
  const results = Array.isArray(user.userInputMessageContext?.toolResults)
    ? user.userInputMessageContext.toolResults.map(normalizeToolResult)
    : [];
  if (calls.length === 0) {
    if (results.length > 0) {
      flattenResults(user, results);
      repairs.orphanResults += results.length;
    }
    if (user.userInputMessageContext) delete user.userInputMessageContext.toolResults;
    cleanUserContext(user);
    return;
  }

  const callQueues = new Map<string, KiroCallRecord[]>();
  const callRecords = calls.map((call, callIndex): KiroCallRecord => {
    const key = rawId(call?.toolUseId);
    const mappedName = nameMap.get(call?.name) || call?.name;
    const input = normalizeToolInput(call?.input);
    const record: KiroCallRecord = { call, callIndex, key, mappedName, input, result: null };
    const queue = callQueues.get(key) || [];
    queue.push(record);
    callQueues.set(key, queue);
    return record;
  });

  const orphanResults: KiroToolResult[] = [];
  for (const result of results) {
    const queue = callQueues.get(rawId(result.toolUseId));
    const record = queue?.find((candidate) => !candidate.result);
    if (record) record.result = result;
    else orphanResults.push(result);
  }

  const keptCalls: KiroToolUse[] = [];
  const keptResults: KiroToolResult[] = [];
  for (const record of callRecords) {
    const hasSpec = typeof record.mappedName === "string" && specNames.has(record.mappedName);
    const valid = !!record.result && hasSpec && record.input !== null;
    if (!valid) {
      appendText(assistant, toolCallText({ name: record.mappedName, input: record.call?.input }));
      repairs.missingResults += record.result ? 0 : 1;
      repairs.invalidToolUses += hasSpec && record.input !== null ? 0 : 1;
      if (record.result) {
        flattenResults(user, [record.result]);
        repairs.orphanResults++;
      }
      continue;
    }

    const toolUseId = reserveToolId(
      record.key,
      turnIndex,
      record.callIndex,
      record.mappedName,
      usedIds
    );
    keptCalls.push({
      toolUseId,
      name: record.mappedName as string,
      input: record.input,
    });
    keptResults.push({ ...record.result, toolUseId });
  }

  if (orphanResults.length > 0) {
    flattenResults(user, orphanResults);
    repairs.orphanResults += orphanResults.length;
  }

  if (keptCalls.length > 0) assistant.toolUses = keptCalls;
  else delete assistant.toolUses;
  user.userInputMessageContext ||= {};
  if (keptResults.length > 0) user.userInputMessageContext.toolResults = keptResults;
  else delete user.userInputMessageContext.toolResults;
  cleanUserContext(user);
}

/** Validate the final Kiro wire conversation without mutating it. */
export function validateKiroConversation(history: unknown, currentMessage: unknown, toolSpecs: KiroToolSpec[] = []) {
  const errors: string[] = [];
  const turns = [...(Array.isArray(history) ? (history as KiroTurn[]) : []), currentMessage as KiroTurn].filter(Boolean);
  const specNames = new Set<string>(
    toolSpecs.map((spec) => spec?.toolSpecification?.name).filter((name): name is string => !!name)
  );
  const usedIds = new Set<string>();

  for (let index = 0; index < turns.length; index++) {
    const expectedUser = index % 2 === 0;
    const isUser = !!turns[index]?.userInputMessage;
    if (isUser !== expectedUser) errors.push(`role:${index}`);
    if (!isUser) {
      const calls = turns[index].assistantResponseMessage?.toolUses || [];
      const results = turns[index + 1]?.userInputMessage?.userInputMessageContext?.toolResults || [];
      const callIds = calls.map((call) => call.toolUseId);
      const resultIds = results.map((result) => result.toolUseId);
      if (calls.length !== results.length || callIds.some((id) => !resultIds.includes(id))) {
        errors.push(`pair:${index}`);
      }
      for (const call of calls) {
        if (!call.toolUseId || usedIds.has(call.toolUseId)) errors.push(`id:${index}`);
        usedIds.add(call.toolUseId);
        if (!specNames.has(call.name)) errors.push(`spec:${index}`);
      }
    } else if (index === 0) {
      const results = turns[index].userInputMessage?.userInputMessageContext?.toolResults;
      if (results?.length) errors.push("orphan:0");
    }
  }
  if (!(currentMessage as KiroTurn | undefined)?.userInputMessage?.content) errors.push("current");
  return { valid: errors.length === 0, errors };
}

function flattenAllStructuredTools(turns: KiroTurn[], repairs: KiroRepairs) {
  for (const turn of turns) {
    if (turn.assistantResponseMessage?.toolUses?.length) {
      for (const call of turn.assistantResponseMessage.toolUses) {
        appendText(turn.assistantResponseMessage, toolCallText(call));
      }
      repairs.invalidToolUses += turn.assistantResponseMessage.toolUses.length;
      delete turn.assistantResponseMessage.toolUses;
    }
    const user = turn.userInputMessage;
    const results = user?.userInputMessageContext?.toolResults;
    if (user && results?.length) {
      flattenResults(user, results);
      repairs.orphanResults += results.length;
      delete user.userInputMessageContext?.toolResults;
      cleanUserContext(user);
    }
  }
}

/**
 * Produce a strict Kiro conversation: alternating turns, current user message,
 * adjacent one-to-one tool use/result pairs, and tool specs only on currentMessage.
 */
export function canonicalizeKiroConversation({
  history,
  currentMessage,
  modelId,
  toolSpecs = [],
  nameMap = new Map<string, string>(),
}: {
  history?: KiroTurn[];
  currentMessage?: KiroTurn;
  modelId: string;
  toolSpecs?: KiroToolSpec[];
  nameMap?: Map<string, string>;
}) {
  const turns = normalizeTurns(history, currentMessage, modelId);
  const repairs: KiroRepairs = { missingResults: 0, orphanResults: 0, invalidToolUses: 0 };
  const specNames = new Set<string>(
    toolSpecs.map((spec) => spec?.toolSpecification?.name).filter((name): name is string => !!name)
  );
  const usedIds = new Set<string>();

  for (let index = 0; index < turns.length; index += 2) {
    const user = turns[index].userInputMessage;
    if (!user) continue;
    if (index === 0) {
      const leadingResults = user.userInputMessageContext?.toolResults || [];
      if (leadingResults.length > 0) {
        flattenResults(user, leadingResults);
        repairs.orphanResults += leadingResults.length;
        delete user.userInputMessageContext?.toolResults;
        cleanUserContext(user);
      }
    }
    const assistant = turns[index + 1]?.assistantResponseMessage;
    const nextUser = turns[index + 2]?.userInputMessage;
    if (assistant && nextUser) {
      reconcileToolPair(assistant, nextUser, index + 1, nameMap, specNames, usedIds, repairs);
    }
  }

  const finalCurrent = turns[turns.length - 1];
  const finalUser = finalCurrent.userInputMessage;
  if (!finalUser) {
    throw new Error("canonicalizeKiroConversation: conversation does not end in a user turn");
  }
  finalUser.userInputMessageContext ||= {};
  if (toolSpecs.length > 0) {
    finalUser.userInputMessageContext.tools = clone(toolSpecs);
  }
  cleanUserContext(finalUser);

  let finalHistory = turns.slice(0, -1);
  let validation = validateKiroConversation(finalHistory, finalCurrent, toolSpecs);
  if (!validation.valid) {
    flattenAllStructuredTools(turns, repairs);
    finalHistory = turns.slice(0, -1);
    validation = validateKiroConversation(finalHistory, finalCurrent, toolSpecs);
  }

  return {
    history: finalHistory,
    currentMessage: finalCurrent,
    repairs,
    valid: validation.valid,
    errors: validation.errors,
  };
}
