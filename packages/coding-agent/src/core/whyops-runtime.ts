import type { ExtensionFactory } from "./extensions/index.js";
import { createWhyOpsExtension } from "./whyops-extension.js";

export const WHYOPS_API_KEY_ENV = "WHYOPS_API_KEY";
export const WHYOPS_BASE_URL_ENV = "WHYOPS_BASE_URL";
export const WHYOPS_AGENT_NAME_ENV = "WHYOPS_AGENT_NAME";

export function getWhyOpsExtensionFactoryFromEnv(options: {
	piVersion: string;
	mode?: "interactive" | "print" | "rpc";
}): ExtensionFactory | undefined {
	const apiKey = process.env[WHYOPS_API_KEY_ENV]?.trim();
	if (!apiKey) {
		return undefined;
	}

	const baseUrl = process.env[WHYOPS_BASE_URL_ENV]?.trim() || undefined;
	const agentName = process.env[WHYOPS_AGENT_NAME_ENV]?.trim() || undefined;

	return createWhyOpsExtension({
		apiKey,
		baseUrl,
		agentName,
		piVersion: options.piVersion,
		mode: options.mode,
	});
}
