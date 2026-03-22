import { createHash, randomUUID } from "node:crypto";

export interface WhyOpsStepContext {
	traceId: string;
	stepId: number;
	parentStepId?: number;
	spanId?: string;
	idempotencyKey: string;
}

interface WhyOpsToolSpanState {
	spanId: string;
	requestStepId?: number;
	responseStepId?: number;
}

export class WhyOpsTraceState {
	private currentTraceId?: string;
	private nextStepIdValue = 1;
	private lastStepId?: number;
	private currentLlmSpanId?: string;
	private currentLlmRequestStepId?: number;
	private readonly toolSpans = new Map<string, WhyOpsToolSpanState>();

	startTrace(traceId: string = randomUUID()): string {
		this.currentTraceId = traceId;
		this.nextStepIdValue = 1;
		this.lastStepId = undefined;
		this.currentLlmSpanId = undefined;
		this.currentLlmRequestStepId = undefined;
		this.toolSpans.clear();
		return traceId;
	}

	reset(): void {
		this.currentTraceId = undefined;
		this.nextStepIdValue = 1;
		this.lastStepId = undefined;
		this.currentLlmSpanId = undefined;
		this.currentLlmRequestStepId = undefined;
		this.toolSpans.clear();
	}

	get traceId(): string | undefined {
		return this.currentTraceId;
	}

	get llmSpanId(): string | undefined {
		return this.currentLlmSpanId;
	}

	get llmRequestStepId(): number | undefined {
		return this.currentLlmRequestStepId;
	}

	getLatestStepId(): number | undefined {
		return this.lastStepId;
	}

	beginLlmSpan(eventType: string, seed?: unknown): WhyOpsStepContext {
		const spanId = randomUUID();
		const step = this.nextStep(eventType, {
			spanId,
			parentStepId: this.lastStepId,
			seed,
		});
		this.currentLlmSpanId = spanId;
		this.currentLlmRequestStepId = step.stepId;
		return step;
	}

	createLlmChildStep(eventType: string, seed?: unknown): WhyOpsStepContext {
		return this.nextStep(eventType, {
			spanId: this.currentLlmSpanId,
			parentStepId: this.currentLlmRequestStepId ?? this.lastStepId,
			seed,
		});
	}

	/**
	 * Like createLlmChildStep but also advances currentLlmRequestStepId to this
	 * step, so that subsequent child steps (e.g. llm_response) chain from the
	 * thinking block rather than from the original user_message.
	 */
	createLlmThinkingStep(eventType: string, seed?: unknown): WhyOpsStepContext {
		const step = this.nextStep(eventType, {
			spanId: this.currentLlmSpanId,
			parentStepId: this.currentLlmRequestStepId ?? this.lastStepId,
			seed,
		});
		this.currentLlmRequestStepId = step.stepId;
		return step;
	}

	beginToolRequest(toolCallId: string, eventType: string, seed?: unknown): WhyOpsStepContext {
		const spanId = randomUUID();
		const step = this.nextStep(eventType, {
			spanId,
			parentStepId: this.lastStepId,
			seed,
		});
		this.toolSpans.set(toolCallId, {
			spanId,
			requestStepId: step.stepId,
		});
		return step;
	}

	finishToolResponse(toolCallId: string, eventType: string, seed?: unknown): WhyOpsStepContext {
		const span = this.toolSpans.get(toolCallId);
		const step = this.nextStep(eventType, {
			spanId: span?.spanId,
			parentStepId: span?.requestStepId ?? this.lastStepId,
			seed,
		});
		if (span) {
			span.responseStepId = step.stepId;
			this.toolSpans.set(toolCallId, span);
		}
		return step;
	}

	createToolResultStep(toolCallId: string, eventType: string, seed?: unknown): WhyOpsStepContext {
		const span = this.toolSpans.get(toolCallId);
		return this.nextStep(eventType, {
			spanId: span?.spanId,
			parentStepId: span?.responseStepId ?? span?.requestStepId ?? this.lastStepId,
			seed,
		});
	}

	createStandaloneStep(eventType: string, seed?: unknown, parentStepId?: number): WhyOpsStepContext {
		return this.nextStep(eventType, {
			parentStepId: parentStepId ?? this.lastStepId,
			seed,
		});
	}

	private nextStep(
		eventType: string,
		options: {
			parentStepId?: number;
			spanId?: string;
			seed?: unknown;
		},
	): WhyOpsStepContext {
		if (!this.currentTraceId) {
			throw new Error("WhyOps trace state is not initialized");
		}

		const stepId = this.nextStepIdValue++;
		const parentStepId = options.parentStepId;
		this.lastStepId = stepId;

		return {
			traceId: this.currentTraceId,
			stepId,
			parentStepId,
			spanId: options.spanId,
			idempotencyKey: createWhyOpsIdempotencyKey({
				traceId: this.currentTraceId,
				stepId,
				eventType,
				spanId: options.spanId,
				seed: options.seed,
			}),
		};
	}
}

export function createWhyOpsIdempotencyKey(input: {
	traceId: string;
	stepId: number;
	eventType: string;
	spanId?: string;
	seed?: unknown;
}): string {
	const hash = createHash("sha256");
	hash.update(stableStringify(input));
	return hash.digest("hex");
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortJsonValue);
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
		return Object.fromEntries(entries.map(([key, entryValue]) => [key, sortJsonValue(entryValue)]));
	}
	return value;
}
