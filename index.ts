/**
 * pi-telegram-tool-status
 *
 * Companion extension for pi-telegram that shows compact Telegram-native
 * tool progress during Telegram-originated turns. It sends individual
 * messages for the first few tool calls, then switches to one overflow
 * summary message for very tool-heavy turns.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// --- Extension Settings ---

interface ExtensionSettings {
	enabled: boolean;
	proactivePushTools: boolean;
}

const DEFAULT_SETTINGS: ExtensionSettings = {
	enabled: true,
	proactivePushTools: true,
};

function getExtensionConfigPath(): string {
	return join(getAgentDir(), "pi-telegram-tool-status.json");
}

async function loadExtensionSettings(): Promise<ExtensionSettings> {
	try {
		const content = await readFile(getExtensionConfigPath(), "utf8");
		const parsed = JSON.parse(content) as Partial<ExtensionSettings>;
		return { ...DEFAULT_SETTINGS, ...parsed };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

async function saveExtensionSettings(settings: ExtensionSettings): Promise<void> {
	try {
		await writeFile(
			getExtensionConfigPath(),
			JSON.stringify(settings, null, "\t") + "\n",
			{ mode: 0o600 },
		);
	} catch {
		// ignore
	}
}

// --- Config ---

interface TelegramConfig {
	botToken?: string;
	allowedUserId?: number;
	proactivePush?: boolean;
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR
		? resolve(process.env.PI_CODING_AGENT_DIR)
		: join(homedir(), ".pi", "agent");
}

async function loadTelegramConfig(): Promise<TelegramConfig> {
	try {
		const content = await readFile(
			join(getAgentDir(), "telegram.json"),
			"utf8",
		);
		return JSON.parse(content) as TelegramConfig;
	} catch {
		return {};
	}
}

// --- Telegram bridge lock ---

async function isTelegramConnected(cwd: string): Promise<boolean> {
	try {
		const content = await readFile(
			join(getAgentDir(), "locks.json"),
			"utf8",
		);
		const locks = JSON.parse(content) as Record<
			string,
			{ pid: number; cwd: string }
		>;
		const entry = locks["@llblab/pi-telegram"];
		if (!entry) return false;
		return entry.pid === process.pid && entry.cwd === cwd;
	} catch {
		return false;
	}
}

// --- Telegram API ---

async function telegramApiCall(
	token: string,
	method: string,
	payload: unknown,
): Promise<unknown> {
	const response = await fetch(
		`https://api.telegram.org/bot${token}/${method}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);
	if (!response.ok) {
		throw new Error(`Telegram API ${method} failed: ${response.status}`);
	}
	const data = (await response.json()) as {
		ok: boolean;
		result?: unknown;
		description?: string;
	};
	if (!data.ok) {
		throw new Error(
			`Telegram API ${method} error: ${data.description ?? "unknown"}`,
		);
	}
	return data.result;
}

// --- Formatting ---

const MAX_DETAIL_LEN = 50; // universal compact limit for all tools
const MAX_VISIBLE_ITEMS = 15;
export const MAX_INDIVIDUAL_TOOL_MESSAGES = 10;

function truncateTail(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max - 1) + "…";
}

function truncateHead(text: string, max: number): string {
	if (text.length <= max) return text;
	return "…" + text.slice(-(max - 1));
}

function maskBashSecrets(command: string): string {
	let masked = command;

	// Authorization / Cookie headers in -H flags
	masked = masked.replace(
		/(-H\s*["']?\s*(?:Authorization|Cookie):\s*)([^"'\n\r]*)/gi,
		"$1***",
	);

	// Authorization / Cookie headers without -H (e.g. curl --header)
	masked = masked.replace(
		/(\b(?:header|H)\s*["']?\s*(?:Authorization|Cookie):\s*)([^"'\n\r]*)/gi,
		"$1***",
	);

	// Bearer / Basic / Token / ApiKey values
	masked = masked.replace(
		/\b(Bearer|Basic|Token|ApiKey)\s+\S+/gi,
		"$1 ***",
	);

	// API keys / tokens / secrets in query strings
	masked = masked.replace(
		/([?&])(api_?key|token|auth|access_token|refresh_token|secret|password|passwd|pwd)=\S+/gi,
		"$1$2=***",
	);

	// Environment variables with sensitive names
	masked = masked.replace(
		/\b([A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD|COOKIE)[A-Z_]*)=\S+/g,
		"$1=***",
	);

	return masked;
}

function smartTruncateBashPaths(command: string, maxPathLen = 50): string {
	return command
		.split(/\s+/)
		.map((token) => {
			if (token.length <= maxPathLen) return token;
			if (!token.includes("/")) return token;
			if (/^https?:\/\//i.test(token)) return token;
			const side = Math.floor((maxPathLen - 1) / 2);
			return token.slice(0, side) + "…" + token.slice(-side);
		})
		.join(" ");
}

function getToolEmoji(toolName: string): string {
	switch (toolName) {
		case "read":
			return "📖";
		case "write":
			return "📝";
		case "edit":
			return "✏️";
		case "bash":
			return "💻";
		default:
			return "⚙️";
	}
}

function formatToolDetail(
	toolName: string,
	args: Record<string, unknown>,
): string {
	const isPathTool =
		toolName === "read" || toolName === "write" || toolName === "edit";
	const isBash = toolName === "bash";

	if (args.path && typeof args.path === "string") {
		const path = args.path;
		return isPathTool
			? truncateHead(path, MAX_DETAIL_LEN)
			: truncateTail(path, MAX_DETAIL_LEN);
	}

	if (args.command && typeof args.command === "string") {
		let cmd = maskBashSecrets(args.command);
		cmd = smartTruncateBashPaths(cmd);
		return isBash
			? truncateTail(cmd, MAX_DETAIL_LEN)
			: truncateTail(cmd, MAX_DETAIL_LEN);
	}

	if (args.url && typeof args.url === "string") {
		try {
			const u = new URL(args.url);
			return truncateTail(u.hostname + u.pathname, MAX_DETAIL_LEN);
		} catch {
			return truncateTail(args.url, MAX_DETAIL_LEN);
		}
	}

	if (args.query && typeof args.query === "string") {
		return truncateTail(args.query, MAX_DETAIL_LEN);
	}

	if (args.file && typeof args.file === "string") {
		return truncateTail(args.file, MAX_DETAIL_LEN);
	}

	if (args.tool && typeof args.tool === "string") {
		const server =
			args.server && typeof args.server === "string"
				? args.server
				: undefined;
		const label = server ? `${server}/${args.tool}` : args.tool;
		return truncateTail(label, MAX_DETAIL_LEN);
	}

	if (args.server && typeof args.server === "string") {
		return truncateTail(args.server, MAX_DETAIL_LEN);
	}

	return toolName;
}

export interface ToolCallInfo {
	index: number;
	toolName: string;
	emoji: string;
	detail: string;
}

export function buildLiveToolMessage(call: ToolCallInfo): string {
	const separator = call.detail ? " — " : "";
	return `🛠 ${call.index}. ${call.emoji} ${call.toolName}${separator}${call.detail}`;
}

export function buildOverflowServiceMessageText(calls: ToolCallInfo[]): string {
	const overflowCalls = calls.slice(MAX_INDIVIDUAL_TOOL_MESSAGES);
	if (overflowCalls.length === 0) {
		return "🛠 More tools used:\n\n";
	}

	const hiddenCount = overflowCalls.length - MAX_VISIBLE_ITEMS;
	const visibleCalls =
		hiddenCount > 0 ? overflowCalls.slice(-MAX_VISIBLE_ITEMS) : overflowCalls;

	const lines: string[] = ["🛠 More tools used:", ""];

	if (hiddenCount > 0) {
		lines.push(`… ${hiddenCount} more action${hiddenCount !== 1 ? "s" : ""} hidden`);
	}

	for (const call of visibleCalls) {
		const detail = call.detail;
		const separator = detail ? " — " : "";
		lines.push(
			`${call.index}. ${call.emoji} ${call.toolName}${separator}${detail}`,
		);
	}

	return lines.join("\n");
}

export type LiveToolDeliveryPlan =
	| { type: "individual"; text: string }
	| { type: "create-overflow"; text: string }
	| { type: "update-overflow"; text: string };

export function planLiveToolDelivery(
	calls: ToolCallInfo[],
	overflowMessageExists: boolean,
): LiveToolDeliveryPlan | undefined {
	const latestCall = calls[calls.length - 1];
	if (!latestCall) return undefined;

	if (calls.length <= MAX_INDIVIDUAL_TOOL_MESSAGES) {
		return { type: "individual", text: buildLiveToolMessage(latestCall) };
	}

	return {
		type: overflowMessageExists ? "update-overflow" : "create-overflow",
		text: buildOverflowServiceMessageText(calls),
	};
}

function buildServiceMessageText(calls: ToolCallInfo[]): string {
	if (calls.length === 0) {
		return "🛠 Tools used:\n\n";
	}

	const hiddenCount = calls.length - MAX_VISIBLE_ITEMS;
	const visibleCalls =
		hiddenCount > 0 ? calls.slice(-MAX_VISIBLE_ITEMS) : calls;

	const lines: string[] = ["🛠 Tools used:", ""];

	if (hiddenCount > 0) {
		lines.push(`… ${hiddenCount} more action${hiddenCount !== 1 ? "s" : ""} hidden`);
	}

	for (const call of visibleCalls) {
		const detail = call.detail;
		const separator = detail ? " — " : "";
		lines.push(
			`${call.index}. ${call.emoji} ${call.toolName}${separator}${detail}`,
		);
	}

	return lines.join("\n");
}

// --- State ---

let overflowServiceMessageId: number | undefined;
let currentChatId: number | undefined;
let toolCalls: ToolCallInfo[] = [];
let nextIndex = 1;
let activeTurnIsTelegram = false;
let overflowInitPromise: Promise<void> | undefined;
let currentCwd: string | undefined;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const settings = await loadExtensionSettings();
		if (!settings.enabled) return;

		currentCwd = ctx.cwd;
		activeTurnIsTelegram =
			(await isTelegramConnected(ctx.cwd)) &&
			!!(event.prompt?.startsWith("[telegram]") ?? false);

		// Reset tool tracking for every new turn (Telegram or console)
		overflowServiceMessageId = undefined;
		toolCalls = [];
		nextIndex = 1;
		overflowInitPromise = undefined;

		const config = await loadTelegramConfig();
		if (config.botToken && config.allowedUserId) {
			currentChatId = config.allowedUserId;
		}
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		const settings = await loadExtensionSettings();
		if (!settings.enabled) return;

		// Always collect tool calls (needed for proactive push on console turns)
		const detail = formatToolDetail(
			event.toolName,
			(event.args as Record<string, unknown>) ?? {},
		);
		toolCalls.push({
			index: nextIndex++,
			toolName: event.toolName,
			emoji: getToolEmoji(event.toolName),
			detail,
		});

		// Only manage live progress messages for Telegram-originated turns.
		if (!activeTurnIsTelegram) return;
		if (!(await isTelegramConnected(ctx.cwd))) return;
		if (!currentChatId) return;

		const config = await loadTelegramConfig();
		if (!config.botToken) return;

		const plan = planLiveToolDelivery(
			toolCalls,
			!!overflowServiceMessageId || !!overflowInitPromise,
		);
		if (!plan) return;

		if (plan.type === "individual") {
			try {
				await telegramApiCall(config.botToken, "sendMessage", {
					chat_id: currentChatId,
					text: plan.text,
				});
			} catch {
				// Ignore send failures so tool execution is never blocked.
			}
			return;
		}

		if (plan.type === "create-overflow") {
			if (!overflowInitPromise) {
				overflowInitPromise = (async () => {
					const result = (await telegramApiCall(
						config.botToken!,
						"sendMessage",
						{
							chat_id: currentChatId,
							text: plan.text,
						},
					)) as { message_id: number };
					overflowServiceMessageId = result.message_id;
				})();
			}
			try {
				await overflowInitPromise;
			} catch {
				// Ignore send failures so tool execution is never blocked.
			}
			return;
		}

		try {
			if (!overflowServiceMessageId && overflowInitPromise) {
				await overflowInitPromise;
			}
			if (!overflowServiceMessageId) return;
			await telegramApiCall(config.botToken, "editMessageText", {
				chat_id: currentChatId,
				message_id: overflowServiceMessageId,
				text: plan.text,
			});
		} catch {
			// Ignore edit failures (message may have been deleted, etc.).
		}
	});

	pi.on("agent_end", async () => {
		const settings = await loadExtensionSettings();
		if (!settings.enabled) {
			activeTurnIsTelegram = false;
			overflowInitPromise = undefined;
			toolCalls = [];
			nextIndex = 1;
			return;
		}

		// Proactive push: if this was a console turn with tool calls and
		// proactivePush is enabled, send a one-shot service message.
		if (!activeTurnIsTelegram && toolCalls.length > 0) {
			const capturedCalls = toolCalls.slice(); // snapshot before clear
			const capturedCwd = currentCwd;
			(async () => {
				try {
					if (
						!capturedCwd ||
						!(await isTelegramConnected(capturedCwd))
					) {
						return;
					}
					const config = await loadTelegramConfig();
					if (
						!config.proactivePush ||
						!config.botToken ||
						!currentChatId
					) {
						return;
					}
					// Also respect extension-level proactivePushTools setting
					if (!settings.proactivePushTools) return;
					const text = buildServiceMessageText(capturedCalls);
					await telegramApiCall(config.botToken, "sendMessage", {
						chat_id: currentChatId,
						text,
					});
				} catch {
					// ignore
				}
			})();
		}

		activeTurnIsTelegram = false;
		overflowInitPromise = undefined;
		toolCalls = [];
		nextIndex = 1;
	});

	pi.on("session_shutdown", async () => {
		activeTurnIsTelegram = false;
		overflowInitPromise = undefined;
		overflowServiceMessageId = undefined;
		currentChatId = undefined;
		toolCalls = [];
		nextIndex = 1;
	});

	// --- Telegram Settings Section ---
	// Lazy registration: pi-telegram may load after this extension on /reload.
	// We attempt registration on every before_agent_start until it succeeds.
	let sectionUnregister: (() => void) | undefined;
	let sectionSettings: ExtensionSettings = { ...DEFAULT_SETTINGS };

	async function tryRegisterTelegramSection(): Promise<void> {
		const registry = (globalThis as any).__piTelegramSectionRegistry__;
		if (typeof registry?.register !== "function") return;
		if (sectionUnregister) return; // already registered

		sectionSettings = await loadExtensionSettings();
		sectionUnregister = registry.register({
			id: "pi-telegram-tool-status",
			label: "🛠 Tool Status",
			render: async (_ctx: any) => {
				const s = sectionSettings;
				return {
					text: `<b>🛠 Tool Status</b>\n\nStatus: ${s.enabled ? "🟢 ON" : "⚫️ OFF"}\nProactive push: ${s.proactivePushTools ? "🟢 ON" : "⚫️ OFF"}\n\nShows live tool progress during each Telegram prompt.`,
					parseMode: "html",
				};
			},
			handleCallback: async (_ctx: any) => {
				return "pass";
			},
			settings: {
				label: "🛠 Tool Status",
				order: 10,
				getLabel: () => {
					return `${sectionSettings.enabled ? "🟢" : "⚫️"} Tool Status`;
				},
				open: async (ctx: any) => {
					sectionSettings = await loadExtensionSettings();
					const s = sectionSettings;
					return {
						text: `<b>🛠 Tool Status Settings</b>\n\nConfigure when the extension sends tool-usage messages.`,
						parseMode: "html",
						replyMarkup: {
							inline_keyboard: [
								[
									{
										text: `${s.enabled ? "🟢 ON" : "⚫️ OFF"} Extension enabled`,
										callback_data: ctx.callbackData("toggle-enabled"),
									},
								],
								[
									{
										text: `${s.proactivePushTools ? "🟢 ON" : "⚫️ OFF"} Proactive push tools`,
										callback_data: ctx.callbackData("toggle-proactive"),
									},
								],
							],
						},
					};
				},
				handleCallback: async (ctx: any) => {
					if (ctx.action === "toggle-enabled") {
						sectionSettings.enabled = !sectionSettings.enabled;
						await saveExtensionSettings(sectionSettings);
						await ctx.answerCallback(
							sectionSettings.enabled
								? "Extension enabled"
								: "Extension disabled",
						);
						const s = sectionSettings;
						await ctx.edit({
							text: `<b>🛠 Tool Status Settings</b>\n\nConfigure when the extension sends tool-usage messages.`,
							parseMode: "html",
							replyMarkup: {
								inline_keyboard: [
									[
										{
											text: `${s.enabled ? "🟢 ON" : "⚫️ OFF"} Extension enabled`,
											callback_data: ctx.callbackData("toggle-enabled"),
										},
									],
									[
										{
											text: `${s.proactivePushTools ? "🟢 ON" : "⚫️ OFF"} Proactive push tools`,
											callback_data: ctx.callbackData("toggle-proactive"),
										},
									],
								],
							},
						});
						return "handled";
					}
					if (ctx.action === "toggle-proactive") {
						sectionSettings.proactivePushTools = !sectionSettings.proactivePushTools;
						await saveExtensionSettings(sectionSettings);
						await ctx.answerCallback(
							sectionSettings.proactivePushTools
								? "Proactive push tools enabled"
								: "Proactive push tools disabled",
						);
						const s = sectionSettings;
						await ctx.edit({
							text: `<b>🛠 Tool Status Settings</b>\n\nConfigure when the extension sends tool-usage messages.`,
							parseMode: "html",
							replyMarkup: {
								inline_keyboard: [
									[
										{
											text: `${s.enabled ? "🟢 ON" : "⚫️ OFF"} Extension enabled`,
											callback_data: ctx.callbackData("toggle-enabled"),
										},
									],
									[
										{
											text: `${s.proactivePushTools ? "🟢 ON" : "⚫️ OFF"} Proactive push tools`,
											callback_data: ctx.callbackData("toggle-proactive"),
										},
									],
								],
							},
						});
						return "handled";
					}
					return "pass";
				},
			},
		});
	}

	pi.on("before_agent_start", async (_event, _ctx) => {
		await tryRegisterTelegramSection();
	});

	pi.on("session_shutdown", () => {
		if (sectionUnregister) {
			sectionUnregister();
			sectionUnregister = undefined;
		}
	});
}
