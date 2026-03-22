export type WhyOpsEventType =
	| "user_message"
	| "llm_response"
	| "embedding_request"
	| "embedding_response"
	| "llm_thinking"
	| "tool_call"
	| "tool_call_request"
	| "tool_call_response"
	| "tool_result"
	| "error";

export interface WhyOpsEvent {
	eventType: WhyOpsEventType;
	traceId: string;
	agentName: string;
	spanId?: string;
	stepId?: number;
	parentStepId?: number;
	timestamp?: string;
	content?: unknown;
	metadata?: Record<string, unknown>;
	idempotencyKey?: string;
}

export interface WhyOpsAgentToolDefinition {
	name: string;
	inputSchema: string;
	outputSchema: string;
	description: string;
}

export interface WhyOpsAgentMetadata {
	systemPrompt: string;
	tools: WhyOpsAgentToolDefinition[];
	description?: string;
	[key: string]: unknown;
}

export interface WhyOpsAgentInitRequest {
	agentName: string;
	metadata: WhyOpsAgentMetadata;
}

export interface WhyOpsAgentInitResponse {
	success: boolean;
	agentId: string;
	agentVersionId: string;
	status: "created" | "existing";
	versionHash: string;
}

export interface WhyOpsIngestResponse {
	success: boolean;
	accepted?: boolean;
	queuedCount?: number;
}

export interface WhyOpsAuthContextHeaders {
	userId: string;
	projectId: string;
	environmentId: string;
}

export interface WhyOpsClientOptions {
	baseUrl?: string;
	apiKey?: string;
	authContext?: WhyOpsAuthContextHeaders;
	fetchFn?: typeof fetch;
}

export class WhyOpsHttpError extends Error {
	readonly status: number;
	readonly statusText: string;
	readonly body: string;

	constructor(status: number, statusText: string, body: string) {
		super(`WhyOps request failed: ${status} ${statusText}${body ? ` - ${body}` : ""}`);
		this.name = "WhyOpsHttpError";
		this.status = status;
		this.statusText = statusText;
		this.body = body;
	}
}

export class WhyOpsClient {
	private readonly baseUrl: string;
	private readonly apiKey?: string;
	private readonly authContext?: WhyOpsAuthContextHeaders;
	private readonly fetchFn: typeof fetch;

	constructor(options: WhyOpsClientOptions = {}) {
		this.baseUrl = normalizeWhyOpsBaseUrl(options.baseUrl);
		this.apiKey = options.apiKey;
		this.authContext = options.authContext;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	hasAuth(): boolean {
		return Boolean(this.apiKey || this.authContext);
	}

	async initAgent(payload: WhyOpsAgentInitRequest, signal?: AbortSignal): Promise<WhyOpsAgentInitResponse> {
		return this.request<WhyOpsAgentInitResponse>("/entities/init", payload, signal);
	}

	async ingestEvents(events: WhyOpsEvent | WhyOpsEvent[], signal?: AbortSignal): Promise<WhyOpsIngestResponse> {
		return this.request<WhyOpsIngestResponse>("/events/ingest", events, signal);
	}

	private async request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
		const response = await this.fetchFn(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: this.buildHeaders(),
			body: JSON.stringify(body),
			signal,
		});

		const text = await response.text();
		if (!response.ok) {
			throw new WhyOpsHttpError(response.status, response.statusText, text);
		}

		if (!text) {
			throw new Error(`WhyOps request to ${path} returned an empty response body`);
		}

		return JSON.parse(text) as T;
	}

	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		if (this.apiKey) {
			headers.Authorization = `Bearer ${this.apiKey}`;
		}

		if (this.authContext) {
			headers["X-User-Id"] = this.authContext.userId;
			headers["X-Project-Id"] = this.authContext.projectId;
			headers["X-Environment-Id"] = this.authContext.environmentId;
		}

		return headers;
	}
}

export function normalizeWhyOpsBaseUrl(baseUrl?: string): string {
	const value = (baseUrl || "https://a.whyops.com/api").trim();
	return value.endsWith("/") ? value.slice(0, -1) : value;
}
