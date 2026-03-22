import { createHash } from "node:crypto";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext, ExtensionFactory, ToolInfo } from "./extensions/index.js";
import { type WhyOpsAgentInitRequest, WhyOpsClient, type WhyOpsEvent } from "./whyops.js";
import { WhyOpsEventBatcher } from "./whyops-batcher.js";
import { WhyOpsTraceState } from "./whyops-trace.js";

const GENERIC_OUTPUT_SCHEMA = JSON.stringify({
	type: "object",
	additionalProperties: true,
});

export interface WhyOpsExtensionOptions {
	apiKey: string;
	baseUrl?: string;
	agentName?: string;
	piVersion: string;
	mode?: "interactive" | "print" | "rpc";
	maxBatchSize?: number;
	flushIntervalMs?: number;
	maxRetries?: number;
	baseDelayMs?: number;
}

export function createWhyOpsExtension(options: WhyOpsExtensionOptions): ExtensionFactory {
	return (pi) => {
		const agentName = options.agentName?.trim() || "pi-coding-agent";
		const client = new WhyOpsClient({
			apiKey: options.apiKey,
			baseUrl: options.baseUrl,
		});
		const batcher = new WhyOpsEventBatcher(client, {
			maxBatchSize: options.maxBatchSize,
			flushIntervalMs: options.flushIntervalMs,
			maxRetries: options.maxRetries,
			baseDelayMs: options.baseDelayMs,
			onError: (error) => {
				console.error(`WhyOps telemetry error: ${error.message}`);
			},
		});
		const traceState = new WhyOpsTraceState();

		let activeTurnIndex = 0;
		let initFingerprint: string | undefined;

		function syncTraceToSession(ctx: ExtensionContext): void {
			const sessionId = ctx.sessionManager.getSessionId();
			if (traceState.traceId === sessionId) {
				return;
			}
			traceState.startTrace(sessionId);
		}

		async function ensureAgentInit(ctx: ExtensionContext): Promise<void> {
			const payload = buildInitPayload(agentName, ctx, pi.getAllTools());
			const nextFingerprint = hashJson(payload);
			if (initFingerprint === nextFingerprint) {
				return;
			}

			try {
				await client.initAgent(payload);
				initFingerprint = nextFingerprint;
			} catch (error) {
				console.error(`WhyOps init failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		function enqueue(ctx: ExtensionContext, event: Omit<WhyOpsEvent, "agentName">): void {
			if (!client.hasAuth()) {
				return;
			}

			const metadata = {
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				mode: options.mode,
				piVersion: options.piVersion,
				turnIndex: activeTurnIndex,
				...event.metadata,
			};

			batcher.enqueue({
				...event,
				agentName,
				metadata,
			});
		}

		pi.on("session_start", async (_event, ctx) => {
			await ensureAgentInit(ctx);
			syncTraceToSession(ctx);
		});

		pi.on("session_switch", async (_event, ctx) => {
			await ensureAgentInit(ctx);
			syncTraceToSession(ctx);
		});

		pi.on("agent_start", async (_event, ctx) => {
			await ensureAgentInit(ctx);
			syncTraceToSession(ctx);
		});

		pi.on("turn_start", async (event) => {
			activeTurnIndex = event.turnIndex;
		});

		pi.on("before_provider_request", async (event, ctx) => {
			if (!traceState.traceId) {
				syncTraceToSession(ctx);
			}
			return event.payload;
		});

		pi.on("message_end", async (event, ctx) => {
			if (!traceState.traceId) {
				syncTraceToSession(ctx);
			}

			if (event.message.role === "user") {
				const message = event.message as UserMessage;
				const step = traceState.beginLlmSpan("user_message", message);
				enqueue(ctx, {
					eventType: "user_message",
					...step,
					content: buildUserMessageContent(message),
					metadata: {
						...buildModelMetadata(ctx),
						imageCount: countImageBlocks(message.content),
					},
				});
				return;
			}

			if (event.message.role === "assistant") {
				const message = event.message as AssistantMessage;
				for (const block of message.content) {
					if (block.type !== "thinking") {
						continue;
					}
					const step = traceState.createLlmThinkingStep("llm_thinking", block);
					enqueue(ctx, {
						eventType: "llm_thinking",
						...step,
						content: {
							type: "thinking",
							thinking: block.thinking,
							signature: block.thinkingSignature,
						},
						metadata: buildAssistantMetadata(message),
					});
				}

				if (message.stopReason === "error" || message.stopReason === "aborted") {
					const step = traceState.createLlmChildStep("error", message.errorMessage);
					enqueue(ctx, {
						eventType: "error",
						...step,
						content: {
							message: message.errorMessage || "Assistant request failed",
							stopReason: message.stopReason,
						},
						metadata: buildAssistantMetadata(message),
					});
					return;
				}

				const step = traceState.createLlmChildStep("llm_response", message);
				enqueue(ctx, {
					eventType: "llm_response",
					...step,
					content: {
						content: extractAssistantText(message),
						toolCalls: extractAssistantToolCalls(message),
						finishReason: message.stopReason,
					},
					metadata: buildAssistantMetadata(message),
				});
				return;
			}

			if (event.message.role === "toolResult") {
				const message = event.message as ToolResultMessage;
				const step = traceState.createToolResultStep(message.toolCallId, "tool_result", message);
				enqueue(ctx, {
					eventType: "tool_result",
					...step,
					content: {
						toolName: message.toolName,
						output: normalizeContent(message.content),
					},
					metadata: {
						...buildModelMetadata(ctx),
						tool: message.toolName,
						toolCallId: message.toolCallId,
						isError: message.isError,
					},
				});
			}
		});

		pi.on("tool_execution_start", async (event, ctx) => {
			const step = traceState.beginToolRequest(event.toolCallId, "tool_call_request", event.args);
			enqueue(ctx, {
				eventType: "tool_call_request",
				...step,
				content: {
					toolCalls: [
						{
							name: event.toolName,
							arguments: event.args,
						},
					],
				},
				metadata: {
					...buildModelMetadata(ctx),
					tool: event.toolName,
					toolCallId: event.toolCallId,
				},
			});
		});

		pi.on("tool_execution_end", async (event, ctx) => {
			const step = traceState.finishToolResponse(event.toolCallId, "tool_call_response", event.result);
			enqueue(ctx, {
				eventType: "tool_call_response",
				...step,
				content: {
					toolResults: normalizeUnknownValue(event.result),
				},
				metadata: {
					...buildModelMetadata(ctx),
					tool: event.toolName,
					toolCallId: event.toolCallId,
					isError: event.isError,
				},
			});

			if (event.isError) {
				const errorStep = traceState.createStandaloneStep("error", event.result, step.stepId);
				enqueue(ctx, {
					eventType: "error",
					...errorStep,
					content: {
						message: `Tool ${event.toolName} failed`,
						toolResult: normalizeUnknownValue(event.result),
					},
					metadata: {
						...buildModelMetadata(ctx),
						tool: event.toolName,
						toolCallId: event.toolCallId,
					},
				});
			}
		});

		pi.on("session_shutdown", async () => {
			await batcher.close();
		});
	};
}

function buildInitPayload(agentName: string, ctx: ExtensionContext, tools: ToolInfo[]): WhyOpsAgentInitRequest {
	return {
		agentName,
		metadata: {
			systemPrompt: ctx.getSystemPrompt(),
			description: "pi-coding-agent runtime",
			tools: tools.map((tool) => ({
				name: tool.name,
				inputSchema: JSON.stringify(tool.parameters),
				outputSchema: GENERIC_OUTPUT_SCHEMA,
				description: tool.description,
			})),
		},
	};
}

function buildModelMetadata(ctx: ExtensionContext): Record<string, unknown> {
	return {
		model: ctx.model?.id,
		provider: ctx.model?.provider,
		thinkingLevel: ctx.model?.reasoning ? undefined : "off",
	};
}

function buildAssistantMetadata(message: AssistantMessage): Record<string, unknown> {
	return {
		model: message.model,
		provider: message.provider,
		usage: message.usage,
		stopReason: message.stopReason,
		responseId: message.responseId,
	};
}

function extractAssistantText(message: AssistantMessage): string | null {
	const text = message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
	return text || null;
}

function extractAssistantToolCalls(message: AssistantMessage): Array<Record<string, unknown>> {
	return message.content
		.filter(
			(block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
				block.type === "toolCall",
		)
		.map((block) => ({
			id: block.id,
			function: {
				name: block.name,
				arguments: JSON.stringify(block.arguments),
			},
		}));
}

function buildUserMessageContent(message: UserMessage): Record<string, unknown> {
	return {
		text: extractTextFromContent(message.content),
		content: normalizeContent(message.content),
	};
}

function normalizeContent(content: string | (TextContent | ImageContent)[]): unknown[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return content.map((block) => {
		if (block.type === "text") {
			return { type: "text", text: block.text };
		}
		return {
			type: "image",
			mimeType: block.mimeType,
			data: `[omitted:${block.mimeType}]`,
		};
	});
}

function extractTextFromContent(content: string | (TextContent | ImageContent)[]): string | null {
	if (typeof content === "string") {
		return content || null;
	}

	const text = content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
	return text || null;
}

function countImageBlocks(content: string | (TextContent | ImageContent)[]): number {
	if (typeof content === "string") {
		return 0;
	}
	return content.filter((block) => block.type === "image").length;
}

function normalizeUnknownValue(value: unknown): unknown {
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack };
	}
	return value;
}

function hashJson(value: unknown): string {
	const hash = createHash("sha256");
	hash.update(JSON.stringify(value));
	return hash.digest("hex");
}
