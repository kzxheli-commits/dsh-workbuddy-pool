/**
 * Protocol translation between the three shapes the pool speaks.
 *
 * The scheduling layer only ever sees ONE shape (OpenAI chat), so the two other
 * protocols are pure translation: a request is converted into a chat body, and
 * the upstream's chat stream is converted back into that protocol's events.
 * Rotation, cooldowns, and accounting therefore stay in one place.
 *
 * @module dsh-workbuddy-pool/protocol
 */

import { pickText } from "./util.js";
import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ *
 * Upstream chat SSE parsing
 * ------------------------------------------------------------------ */

const SSE_FRAME_SEPARATOR = /\r?\n\r?\n/u;

/**
 * Parse one OpenAI-style chat SSE stream into semantic events.
 *
 * Events:
 *   { kind: "text", text }
 *   { kind: "reasoning", text }
 *   { kind: "tool_start", index, id, name }
 *   { kind: "tool_args", index, args }
 *   { kind: "usage", input?, output? }
 *   { kind: "finish", reason }
 *   { kind: "done" }
 */
export async function* iterateChatEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  for await (const chunk of body) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let match = SSE_FRAME_SEPARATOR.exec(buffer);
    while (match !== null) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      for (const event of eventsOfFrame(frame)) {
        if (event.kind === "done") finished = true;
        yield event;
      }
      match = SSE_FRAME_SEPARATOR.exec(buffer);
    }
  }
  if (buffer.trim() !== "") {
    for (const event of eventsOfFrame(buffer)) yield event;
  }
  if (!finished) yield { kind: "done" };
}

/** Parse the `data:` lines of one SSE frame into semantic events. */
function* eventsOfFrame(frame) {
  for (const rawLine of frame.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "") continue;
    if (payload === "[DONE]") {
      yield { kind: "done" };
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const usage = parsed["usage"];
    if (typeof usage === "object" && usage !== null) {
      const input = typeof usage["prompt_tokens"] === "number" ? usage["prompt_tokens"] : undefined;
      const output = typeof usage["completion_tokens"] === "number" ? usage["completion_tokens"] : undefined;
      if (input !== undefined || output !== undefined) yield { kind: "usage", input, output };
    }
    const choices = parsed["choices"];
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const choice = choices[0];
    const delta = typeof choice["delta"] === "object" && choice["delta"] !== null ? choice["delta"] : choice["message"];
    if (typeof delta === "object" && delta !== null) {
      const content = delta["content"];
      if (typeof content === "string" && content !== "") yield { kind: "text", text: content };
      const reasoning =
        typeof delta["reasoning_content"] === "string"
          ? delta["reasoning_content"]
          : typeof delta["reasoning"] === "string"
            ? delta["reasoning"]
            : undefined;
      if (reasoning !== undefined && reasoning !== "") yield { kind: "reasoning", text: reasoning };
      const toolCalls = delta["tool_calls"];
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          if (typeof call !== "object" || call === null) continue;
          const index = typeof call["index"] === "number" ? call["index"] : 0;
          const id = typeof call["id"] === "string" ? call["id"] : undefined;
          const fn = typeof call["function"] === "object" && call["function"] !== null ? call["function"] : {};
          const name = typeof fn["name"] === "string" ? fn["name"] : undefined;
          if (id !== undefined || name !== undefined) yield { kind: "tool_start", index, id, name };
          const args = fn["arguments"];
          if (typeof args === "string" && args !== "") yield { kind: "tool_args", index, args };
        }
      }
    }
    const finish = choice["finish_reason"];
    if (typeof finish === "string" && finish !== "") yield { kind: "finish", reason: finish };
  }
}

/** Collect a full OpenAI chat completion object from one upstream stream. */
export async function collectChatCompletion(body, options = {}) {
  const id = options.id ?? `chatcmpl-${randomUUID().replace(/-/gu, "").slice(0, 24)}`;
  const created = options.created ?? Math.floor(Date.now() / 1000);
  let text = "";
  const toolCalls = [];
  let finishReason = "stop";
  let usage;
  for await (const event of iterateChatEvents(body)) {
    if (event.kind === "text") text += event.text;
    else if (event.kind === "tool_start") {
      toolCalls[event.index] ??= { id: event.id ?? `call_${randomUUID().replace(/-/gu, "").slice(0, 16)}`, name: event.name ?? "", arguments: "" };
      if (event.name !== undefined) toolCalls[event.index].name = event.name;
    } else if (event.kind === "tool_args") {
      toolCalls[event.index] ??= { id: `call_${randomUUID().replace(/-/gu, "").slice(0, 16)}`, name: "", arguments: "" };
      toolCalls[event.index].arguments += event.args;
    } else if (event.kind === "usage") {
      usage = {
        prompt_tokens: event.input ?? 0,
        completion_tokens: event.output ?? 0,
        total_tokens: (event.input ?? 0) + (event.output ?? 0),
      };
    } else if (event.kind === "finish") finishReason = event.reason;
  }
  const calls = toolCalls.filter(Boolean);
  return {
    id,
    object: "chat.completion",
    created,
    model: options.model ?? "workbuddy",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text === "" && calls.length > 0 ? null : text,
          ...(calls.length === 0 ? {} : { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) }),
        },
        finish_reason: calls.length > 0 ? "tool_calls" : finishReason,
      },
    ],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/* ------------------------------------------------------------------ *
 * OpenAI Responses API
 * ------------------------------------------------------------------ */

/** Render one chat content part for a text/image content array. */
function chatContentOf(parts) {
  const out = [];
  for (const part of parts) {
    if (typeof part === "string") {
      out.push({ type: "text", text: part });
      continue;
    }
    if (typeof part !== "object" || part === null) continue;
    const type = part["type"];
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = typeof part["text"] === "string" ? part["text"] : "";
      if (text !== "") out.push({ type: "text", text });
    } else if (type === "input_image" || type === "image_url") {
      const url = typeof part["image_url"] === "string" ? part["image_url"] : part["image_url"]?.["url"];
      if (typeof url === "string" && url !== "") out.push({ type: "image_url", image_url: { url } });
    }
  }
  return out;
}

/** Convert one Responses request body into an OpenAI chat body. */
export function responsesToChatBody(request) {
  const messages = [];
  const instructions = typeof request["instructions"] === "string" ? request["instructions"] : "";
  if (instructions !== "") messages.push({ role: "system", content: instructions });
  const input = request["input"];
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    // Tool calls and results must be paired before they reach the upstream; the
    // host history can legitimately contain one without the other after a trim.
    const pendingCallIds = new Set();
    for (const item of input) {
      if (typeof item !== "object" || item === null) continue;
      const type = item["type"];
      if (type === "message" || type === undefined) {
        const role = typeof item["role"] === "string" ? item["role"] : "user";
        const content = item["content"];
        if (typeof content === "string") messages.push({ role: role === "developer" ? "system" : role, content });
        else if (Array.isArray(content)) messages.push({ role: role === "developer" ? "system" : role, content: chatContentOf(content) });
      } else if (type === "function_call") {
        const callId = typeof item["call_id"] === "string" ? item["call_id"] : typeof item["id"] === "string" ? item["id"] : undefined;
        const name = typeof item["name"] === "string" ? item["name"] : "";
        const args = typeof item["arguments"] === "string" ? item["arguments"] : "";
        const message = { role: "assistant", content: null, tool_calls: [{ id: callId ?? `call_${name}`, type: "function", function: { name, arguments: args } }] };
        const previous = messages[messages.length - 1];
        if (previous !== undefined && previous.role === "assistant" && Array.isArray(previous.tool_calls) && previous.content === null) {
          previous.tool_calls.push(message.tool_calls[0]);
        } else {
          messages.push(message);
        }
        if (callId !== undefined) pendingCallIds.add(callId);
      } else if (type === "function_call_output") {
        const callId = typeof item["call_id"] === "string" ? item["call_id"] : undefined;
        messages.push({ role: "tool", tool_call_id: callId ?? "", content: typeof item["output"] === "string" ? item["output"] : JSON.stringify(item["output"] ?? "") });
        if (callId !== undefined) pendingCallIds.delete(callId);
      }
      // reasoning / item_reference items carry no wire meaning for the upstream.
    }
  }
  const tools = Array.isArray(request["tools"])
    ? request["tools"]
        .filter((tool) => typeof tool === "object" && tool !== null && tool["type"] === "function")
        .map((tool) => ({
          type: "function",
          function: {
            name: typeof tool["name"] === "string" ? tool["name"] : "",
            ...(typeof tool["description"] === "string" && tool["description"] !== "" ? { description: tool["description"] } : {}),
            ...(typeof tool["parameters"] === "object" && tool["parameters"] !== null ? { parameters: tool["parameters"] } : {}),
          },
        }))
    : undefined;
  const body = {
    model: request["model"],
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
  };
  const choice = request["tool_choice"];
  if (typeof choice === "string") body.tool_choice = choice;
  else if (typeof choice === "object" && choice !== null && typeof choice["name"] === "string") {
    body.tool_choice = { type: "function", function: { name: choice["name"] } };
  }
  if (typeof request["max_output_tokens"] === "number") body.max_tokens = request["max_output_tokens"];
  if (typeof request["temperature"] === "number") body.temperature = request["temperature"];
  if (typeof request["top_p"] === "number") body.top_p = request["top_p"];
  const reasoning = request["reasoning"];
  if (typeof reasoning === "object" && reasoning !== null && typeof reasoning["effort"] === "string") {
    body.reasoning_effort = reasoning["effort"];
  }
  if (request["parallel_tool_calls"] === false) body.parallel_tool_calls = false;
  return body;
}

/** One `.response` object for the Responses API. */
function responsesObject({ id, model, output, usage, status = "completed" }) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    output_text: output
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content)
      .filter((part) => part.type === "output_text")
      .map((part) => part.text)
      .join(""),
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

/** Build the Responses API's output items from collected chat pieces. */
function responsesOutput({ itemId, text, calls }) {
  const output = [];
  if (text !== "" || calls.length === 0) {
    output.push({
      id: `msg_${itemId}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const [index, call] of calls.entries()) {
    output.push({
      id: `fc_${itemId}_${index}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }
  return output;
}

/** Non-streaming Responses reply from one collected chat completion. */
export function chatCompletionToResponses(completion, request) {
  const message = completion.choices?.[0]?.message ?? {};
  const text = typeof message.content === "string" ? message.content : "";
  const calls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => ({ id: call.id, name: call.function?.name ?? "", arguments: call.function?.arguments ?? "" }))
    : [];
  const itemId = randomUUID().replace(/-/gu, "").slice(0, 16);
  const responseId = `resp_${itemId}`;
  return responsesObject({
    id: responseId,
    model: completion.model ?? request?.model,
    output: responsesOutput({ itemId, text, calls }),
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  });
}

/**
 * Stream one Responses reply from the upstream chat stream.
 * `write(eventName, dataObject)` receives every SSE event to forward.
 */
export async function streamResponses(events, options) {
  const { write, model, request } = options;
  const itemId = randomUUID().replace(/-/gu, "").slice(0, 16);
  const responseId = `resp_${itemId}`;
  let text = "";
  const calls = [];
  let finishReason;
  let usage;
  const created = responsesObject({ id: responseId, model, output: [], usage: undefined, status: "in_progress" });
  write("response.created", { type: "response.created", response: created });
  write("response.in_progress", { type: "response.in_progress", response: created });
  let messageAdded = false;
  let textPartAdded = false;
  let outputIndex = 0;
  const ensureMessage = () => {
    if (messageAdded) return;
    messageAdded = true;
    write("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { id: `msg_${itemId}`, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    write("response.content_part.added", {
      type: "response.content_part.added",
      item_id: `msg_${itemId}`,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    textPartAdded = true;
  };
  for await (const event of events) {
    if (event.kind === "text") {
      ensureMessage();
      text += event.text;
      write("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: `msg_${itemId}`,
        output_index: outputIndex,
        content_index: 0,
        delta: event.text,
      });
    } else if (event.kind === "tool_start") {
      const index = event.index ?? calls.length;
      calls[index] ??= { id: event.id ?? `call_${randomUUID().replace(/-/gu, "").slice(0, 16)}`, name: event.name ?? "", arguments: "" };
      if (event.name !== undefined) calls[index].name = event.name;
      const callIndex = outputIndex + (messageAdded ? 1 : 0) + index;
      write("response.output_item.added", {
        type: "response.output_item.added",
        output_index: callIndex,
        item: { id: `fc_${itemId}_${index}`, type: "function_call", status: "in_progress", call_id: calls[index].id, name: calls[index].name, arguments: "" },
      });
    } else if (event.kind === "tool_args") {
      const index = event.index ?? 0;
      calls[index] ??= { id: `call_${randomUUID().replace(/-/gu, "").slice(0, 16)}`, name: "", arguments: "" };
      calls[index].arguments += event.args;
      const callIndex = outputIndex + (messageAdded ? 1 : 0) + index;
      write("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: `fc_${itemId}_${index}`,
        output_index: callIndex,
        delta: event.args,
      });
    } else if (event.kind === "usage") {
      usage = { input_tokens: event.input ?? 0, output_tokens: event.output ?? 0 };
    } else if (event.kind === "finish") {
      finishReason = event.reason;
    }
  }
  const finalCalls = calls.filter(Boolean);
  const output = responsesOutput({ itemId, text, calls: finalCalls });
  // Close the message item, then every function call item.
  if (messageAdded) {
    write("response.output_text.done", {
      type: "response.output_text.done",
      item_id: `msg_${itemId}`,
      output_index: outputIndex,
      content_index: 0,
      text,
    });
    if (textPartAdded) {
      write("response.content_part.done", {
        type: "response.content_part.done",
        item_id: `msg_${itemId}`,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      });
    }
    write("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: output[0],
    });
  }
  for (const [index, call] of finalCalls.entries()) {
    const callIndex = outputIndex + (messageAdded ? 1 : 0) + index;
    write("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: `fc_${itemId}_${index}`,
      output_index: callIndex,
      arguments: call.arguments,
    });
    write("response.output_item.done", {
      type: "response.output_item.done",
      output_index: callIndex,
      item: output[messageAdded ? index + 1 : index],
    });
  }
  const finalResponse = responsesObject({
    id: responseId,
    model,
    output,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    },
  });
  write("response.completed", { type: "response.completed", response: finalResponse });
  return { text, calls: finalCalls, finishReason, usage, request };
}

/* ------------------------------------------------------------------ *
 * Anthropic Messages API
 * ------------------------------------------------------------------ */

/** Convert one Anthropic request body into an OpenAI chat body. */
export function anthropicToChatBody(request) {
  const messages = [];
  const system = request["system"];
  if (typeof system === "string" && system !== "") messages.push({ role: "system", content: system });
  else if (Array.isArray(system)) {
    const text = system
      .filter((block) => typeof block === "object" && block !== null && block["type"] === "text")
      .map((block) => block["text"])
      .join("\n");
    if (text !== "") messages.push({ role: "system", content: text });
  }
  for (const entry of Array.isArray(request["messages"]) ? request["messages"] : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const role = entry["role"] === "assistant" ? "assistant" : "user";
    const content = entry["content"];
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    const parts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const block of Array.isArray(content) ? content : []) {
      if (typeof block !== "object" || block === null) continue;
      const type = block["type"];
      if (type === "text") {
        if (typeof block["text"] === "string" && block["text"] !== "") parts.push({ type: "text", text: block["text"] });
      } else if (type === "image") {
        const source = block["source"];
        if (source !== undefined && source["type"] === "base64" && typeof source["data"] === "string") {
          parts.push({ type: "image_url", image_url: { url: `data:${source["media_type"] ?? "image/png"};base64,${source["data"]}` } });
        } else if (source !== undefined && typeof source["url"] === "string") {
          parts.push({ type: "image_url", image_url: { url: source["url"] } });
        }
      } else if (type === "tool_use") {
        toolCalls.push({
          id: typeof block["id"] === "string" ? block["id"] : `call_${randomUUID().replace(/-/gu, "").slice(0, 16)}`,
          type: "function",
          function: { name: typeof block["name"] === "string" ? block["name"] : "", arguments: JSON.stringify(block["input"] ?? {}) },
        });
      } else if (type === "tool_result") {
        const inner = block["content"];
        const text =
          typeof inner === "string"
            ? inner
            : Array.isArray(inner)
              ? inner
                  .filter((item) => typeof item === "object" && item !== null && item["type"] === "text")
                  .map((item) => item["text"])
                  .join("\n")
              : "";
        toolResults.push({ role: "tool", tool_call_id: typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "", content: text });
      }
    }
    if (role === "assistant") {
      if (parts.length > 0 || toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: parts.length > 0 ? parts.map((part) => part.text ?? "").join("") : null,
          ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
        });
      }
    } else {
      if (parts.length > 0) messages.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
      for (const result of toolResults) messages.push(result);
    }
  }
  const tools = Array.isArray(request["tools"])
    ? request["tools"].map((tool) => ({
        type: "function",
        function: {
          name: typeof tool["name"] === "string" ? tool["name"] : "",
          ...(typeof tool["description"] === "string" && tool["description"] !== "" ? { description: tool["description"] } : {}),
          ...(typeof tool["input_schema"] === "object" && tool["input_schema"] !== null ? { parameters: tool["input_schema"] } : {}),
        },
      }))
    : undefined;
  const body = {
    model: request["model"],
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
  };
  const choice = request["tool_choice"];
  if (typeof choice === "object" && choice !== null) {
    if (choice["type"] === "auto") body.tool_choice = "auto";
    else if (choice["type"] === "any") body.tool_choice = "required";
    else if (choice["type"] === "none") body.tool_choice = "none";
    else if (choice["type"] === "tool" && typeof choice["name"] === "string") {
      body.tool_choice = { type: "function", function: { name: choice["name"] } };
    }
  }
  if (typeof request["max_tokens"] === "number") body.max_tokens = request["max_tokens"];
  if (typeof request["temperature"] === "number") body.temperature = request["temperature"];
  if (typeof request["top_p"] === "number") body.top_p = request["top_p"];
  if (Array.isArray(request["stop_sequences"]) && request["stop_sequences"].length > 0) body.stop = request["stop_sequences"];
  return body;
}

/** Anthropic stop-reason mapping from an OpenAI finish reason. */
function anthropicStopReason(reason, hasToolUse) {
  if (hasToolUse) return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  return "end_turn";
}

/** Non-streaming Anthropic reply from one collected chat completion. */
export function chatCompletionToAnthropic(completion, request) {
  const message = completion.choices?.[0]?.message ?? {};
  const text = typeof message.content === "string" ? message.content : "";
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const content = [];
  if (text !== "" || calls.length === 0) content.push({ type: "text", text });
  for (const call of calls) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments ?? "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: call.id, name: call.function?.name ?? "", input });
  }
  return {
    id: `msg_${randomUUID().replace(/-/gu, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model: completion.model ?? request?.model,
    content,
    stop_reason: anthropicStopReason(completion.choices?.[0]?.finish_reason, calls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Stream one Anthropic reply from the upstream chat stream.
 * `write(eventName, dataObject)` receives every SSE event to forward.
 */
export async function streamAnthropic(events, options) {
  const { write, model } = options;
  const messageId = `msg_${randomUUID().replace(/-/gu, "").slice(0, 24)}`;
  let nextIndex = 0;
  let openBlock;
  let finishReason;
  let usage;
  let toolCount = 0;
  /** Upstream tool index -> Anthropic content block. */
  const toolBlocks = new Map();
  const closeBlock = () => {
    if (openBlock === undefined) return;
    write("content_block_stop", { type: "content_block_stop", index: openBlock.index });
    openBlock = undefined;
  };
  const startTextBlock = () => {
    closeBlock();
    const block = { kind: "text", index: nextIndex };
    nextIndex += 1;
    openBlock = block;
    write("content_block_start", {
      type: "content_block_start",
      index: block.index,
      content_block: { type: "text", text: "" },
    });
    return block;
  };
  const startToolBlock = (toolIndex, id, name) => {
    let block = toolBlocks.get(toolIndex);
    if (block === undefined) {
      block = { kind: "tool", index: nextIndex, id: id ?? `toolu_${randomUUID().replace(/-/gu, "").slice(0, 20)}`, name: name ?? "" };
      nextIndex += 1;
      toolBlocks.set(toolIndex, block);
    }
    if (id !== undefined) block.id = id;
    if (name !== undefined && name !== "") block.name = name;
    closeBlock();
    openBlock = block;
    write("content_block_start", {
      type: "content_block_start",
      index: block.index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    });
    return block;
  };
  write("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  for await (const event of events) {
    if (event.kind === "text") {
      if (openBlock === undefined || openBlock.kind !== "text") startTextBlock();
      write("content_block_delta", {
        type: "content_block_delta",
        index: openBlock.index,
        delta: { type: "text_delta", text: event.text },
      });
    } else if (event.kind === "tool_start") {
      toolCount += 1;
      if (openBlock === undefined || openBlock.kind !== "tool") startToolBlock(event.index ?? toolCount - 1, event.id, event.name);
      else if (event.name !== undefined && event.name !== "" && openBlock.name === "") {
        // A name that arrives after the block opened cannot be rewritten; the
        // upstream sends it on the first delta in practice, so this is rare.
        openBlock.name = event.name;
      }
    } else if (event.kind === "tool_args") {
      let block = toolBlocks.get(event.index ?? 0);
      if (block === undefined) block = startToolBlock(event.index ?? 0, undefined, undefined);
      else if (openBlock !== block) {
        closeBlock();
        openBlock = block;
        write("content_block_start", {
          type: "content_block_start",
          index: block.index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        });
      }
      write("content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: { type: "input_json_delta", partial_json: event.args },
      });
    } else if (event.kind === "usage") {
      usage = { input_tokens: event.input ?? 0, output_tokens: event.output ?? 0 };
    } else if (event.kind === "finish") {
      finishReason = event.reason;
    }
  }
  closeBlock();
  write("message_delta", {
    type: "message_delta",
    delta: { stop_reason: anthropicStopReason(finishReason, toolCount > 0), stop_sequence: null },
    usage: { output_tokens: usage?.output_tokens ?? 0 },
  });
  write("message_stop", { type: "message_stop" });
  return { toolCount, finishReason, usage };
}

/** Whether this Responses request asks for a stream. */
export function wantsStream(request) {
  return request["stream"] === true;
}

/** The user-facing model id from any of the three request shapes. */
export function modelOf(request) {
  return typeof request["model"] === "string" && request["model"] !== "" ? request["model"] : "unknown";
}

/** A short conversation key for sticky routing (best effort, stable per history). */
export function sessionKeyOf(request) {
  return pickText([request], ["prompt_cache_key", "conversation_id", "session_id", "user"]);
}
