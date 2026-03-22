import type { WhyOpsClient, WhyOpsEvent } from "./whyops.js";

export interface WhyOpsBatcherOptions {
	maxBatchSize?: number;
	flushIntervalMs?: number;
	maxRetries?: number;
	baseDelayMs?: number;
	onError?: (error: Error, batch: WhyOpsEvent[]) => void;
}

export class WhyOpsEventBatcher {
	private readonly client: WhyOpsClient;
	private readonly maxBatchSize: number;
	private readonly flushIntervalMs: number;
	private readonly maxRetries: number;
	private readonly baseDelayMs: number;
	private readonly onError?: (error: Error, batch: WhyOpsEvent[]) => void;
	private queue: WhyOpsEvent[] = [];
	private timer?: ReturnType<typeof setTimeout>;
	private flushPromise: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(client: WhyOpsClient, options: WhyOpsBatcherOptions = {}) {
		this.client = client;
		this.maxBatchSize = options.maxBatchSize ?? 20;
		this.flushIntervalMs = options.flushIntervalMs ?? 1000;
		this.maxRetries = options.maxRetries ?? 3;
		this.baseDelayMs = options.baseDelayMs ?? 250;
		this.onError = options.onError;
	}

	enqueue(event: WhyOpsEvent): void {
		if (this.closed) {
			return;
		}

		this.queue.push(event);
		if (this.queue.length >= this.maxBatchSize) {
			void this.flush();
			return;
		}

		this.ensureTimer();
	}

	flush(): Promise<void> {
		this.flushPromise = this.flushPromise.then(
			() => this.flushInternal(),
			() => this.flushInternal(),
		);
		return this.flushPromise;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.clearTimer();
		await this.flush();
	}

	private async flushInternal(): Promise<void> {
		this.clearTimer();
		if (this.queue.length === 0) {
			return;
		}

		const batch = this.queue.splice(0, this.maxBatchSize);

		try {
			await this.sendWithRetry(batch);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.onError?.(err, batch);
		}

		if (!this.closed && this.queue.length > 0) {
			this.ensureTimer();
		}
	}

	private async sendWithRetry(batch: WhyOpsEvent[]): Promise<void> {
		let attempt = 0;
		let lastError: Error | undefined;

		while (attempt <= this.maxRetries) {
			try {
				await this.client.ingestEvents(batch);
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				attempt++;
				if (attempt > this.maxRetries) {
					break;
				}
				await sleep(this.baseDelayMs * 2 ** (attempt - 1));
			}
		}

		throw lastError ?? new Error("WhyOps batch delivery failed");
	}

	private ensureTimer(): void {
		if (this.timer) {
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, this.flushIntervalMs);
	}

	private clearTimer(): void {
		if (!this.timer) {
			return;
		}
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
