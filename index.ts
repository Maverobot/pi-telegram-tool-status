/**
 * pi-telegram-tool-status
 *
 * Companion extension for pi-telegram that posts a compact service message
 * to Telegram showing which tools the agent uses. One service message is
 * created per user prompt and edited in-place as new tool calls arrive.
 *
 * Install: place this file in ~/.pi/agent/extensions/pi-telegram-tool-status.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// --- Config ---

interface TelegramConfig {
	botToken?: string;
	allowedUserId?: number;
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

const MAX_PATH_LEN = 60;   // tail matters: show the filename
const MAX_BASH_LEN = 80;   // head matters: show the command start
const MAX_OTHER_LEN = 50; // minimal for custom tools
const MAX_VISIBLE_ITEMS = 15;

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
	const isPathTool = toolName === "read" || toolName === "write" || toolName === "edit";
	const isBash = toolName === "bash";

	if (args.path && typeof args.path === "string") {
		const path = args.path;
		return isPathTool ? truncateHead(path, MAX_PATH_LEN) : truncateTail(path, MAX_PATH_LEN);
	}

	if (args.command && typeof args.command === "string") {
		const cmd = maskBashSecrets(args.command);
		return isBash ? truncateTail(cmd, MAX_BASH_LEN) : truncateTail(cmd, MAX_OTHER_LEN);
	}

	if (args.url && typeof args.url === "string") {
		try {
			const u = new URL(args.url);
			return truncateTail(u.hostname + u.pathname, MAX_OTHER_LEN);
		} catch {
			return truncateTail(args.url, MAX_OTHER_LEN);
		}
	}

	if (args.query && typeof args.query === "string") {
		return truncateTail(args.query, MAX_OTHER_LEN);
	}

	if (args.file && typeof args.file === "string") {
		return truncateTail(args.file, MAX_OTHER_LEN);
	}

	if (args.tool && typeof args.tool === "string") {
		const server = args.server && typeof args.server === "string"
			? args.server
			: undefined;
		const label = server ? `${server}/${args.tool}` : args.tool;
		return truncateTail(label, MAX_OTHER_LEN);
	}

	if (args.server && typeof args.server === "string") {
		return truncateTail(args.server, MAX_OTHER_LEN);
	}

	// Memory / recall / session_search — just show the operation name
	return toolName;
}

interface ToolCallInfo {
	index: number;
	toolName: string;
	emoji: string;
	detail: string;
}

function buildServiceMessageText(calls: ToolCallInfo[]): string {
	if (calls.length === 0) {
		return "🛠 Использованы инструменты:\n\n";
	}

	const hiddenCount = calls.length - MAX_VISIBLE_ITEMS;
	const visibleCalls =
		hiddenCount > 0 ? calls.slice(-MAX_VISIBLE_ITEMS) : calls;

	const lines: string[] = ["🛠 Использованы инструменты:", ""];

	if (hiddenCount > 0) {
		lines.push(`… ещё ${hiddenCount} ${pluralize(hiddenCount, "действие", "действия", "действий")} скрыто`);
	}

	for (const call of visibleCalls) {
		const detail = call.detail;
		const separator = detail ? " — " : "";
		lines.push(`${call.index}. ${call.emoji} ${call.toolName}${separator}${detail}`);
	}

	return lines.join("\n");
}

function pluralize(n: number, one: string, few: string, many: string): string {
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (mod100 >= 11 && mod100 <= 19) return many;
	if (mod10 === 1) return one;
	if (mod10 >= 2 && mod10 <= 4) return few;
	return many;
}

async function isTelegramConnected(cwd: string): Promise<boolean> {
	try {
		const content = await readFile(join(getAgentDir(), "locks.json"), "utf8");
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

// --- State ---

let currentServiceMessageId: number | undefined;
let currentChatId: number | undefined;
let toolCalls: ToolCallInfo[] = [];
let nextIndex = 1;
let agentActive = false;
let initPromise: Promise<void> | undefined;

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", async (_event, ctx) => {
		if (!(await isTelegramConnected(ctx.cwd))) return;

		// Reset state for a new user prompt
		currentServiceMessageId = undefined;
		currentChatId = undefined;
		toolCalls = [];
		nextIndex = 1;
		agentActive = true;
		initPromise = undefined;

		const config = await loadTelegramConfig();
		if (config.botToken && config.allowedUserId) {
			currentChatId = config.allowedUserId;
		}
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!agentActive) return;
		if (!(await isTelegramConnected(ctx.cwd))) return;

		if (!currentChatId) return;

		// Lazy-create the service message on the very first tool call
		if (!currentServiceMessageId) {
			if (!initPromise) {
				initPromise = (async () => {
					const config = await loadTelegramConfig();
					if (!config.botToken) return;
					const result = (await telegramApiCall(
						config.botToken,
						"sendMessage",
						{
							chat_id: currentChatId,
							text: "🛠 Использованы инструменты:\n\n",
						},
					)) as { message_id: number };
					currentServiceMessageId = result.message_id;
				})();
			}
			try {
				await initPromise;
			} catch {
				return;
			}
		}

		if (!currentServiceMessageId) return;

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

		const config = await loadTelegramConfig();
		if (!config.botToken) return;

		const text = buildServiceMessageText(toolCalls);

		try {
			await telegramApiCall(config.botToken, "editMessageText", {
				chat_id: currentChatId,
				message_id: currentServiceMessageId,
				text,
			});
		} catch {
			// Ignore edit failures (message may have been deleted, etc.)
		}
	});

	pi.on("agent_end", async () => {
		agentActive = false;
		initPromise = undefined;
		// Leave the final service message in place so the user can review
	});

	pi.on("session_shutdown", async () => {
		agentActive = false;
		initPromise = undefined;
		currentServiceMessageId = undefined;
		currentChatId = undefined;
		toolCalls = [];
		nextIndex = 1;
	});
}
