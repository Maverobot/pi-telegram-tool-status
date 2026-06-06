import test from "node:test";
import assert from "node:assert/strict";
import {
	MAX_INDIVIDUAL_TOOL_MESSAGES,
	buildLiveToolMessage,
	buildOverflowServiceMessageText,
	planLiveToolDelivery,
	type ToolCallInfo,
} from "../index.ts";

function makeCall(index: number): ToolCallInfo {
	return {
		index,
		toolName: `tool${index}`,
		emoji: "⚙️",
		detail: `detail${index}`,
	};
}

test("buildLiveToolMessage formats one compact per-tool message", () => {
	assert.equal(
		buildLiveToolMessage({
			index: 2,
			toolName: "bash",
			emoji: "💻",
			detail: "npm test",
		}),
		"🛠 2. 💻 bash — npm test",
	);
});

test("buildOverflowServiceMessageText summarizes only tools past the individual cap", () => {
	const calls = Array.from({ length: MAX_INDIVIDUAL_TOOL_MESSAGES + 2 }, (_, i) =>
		makeCall(i + 1),
	);

	const text = buildOverflowServiceMessageText(calls);

	assert.match(text, /^🛠 More tools used:/);
	assert.match(text, /11\. ⚙️ tool11 — detail11/);
	assert.match(text, /12\. ⚙️ tool12 — detail12/);
	assert.doesNotMatch(text, /1\. ⚙️ tool1 — detail1/);
});

test("planLiveToolDelivery sends individual messages before switching to overflow summary", () => {
	const firstCalls = Array.from({ length: MAX_INDIVIDUAL_TOOL_MESSAGES }, (_, i) =>
		makeCall(i + 1),
	);
	assert.deepEqual(planLiveToolDelivery(firstCalls, false), {
		type: "individual",
		text: `🛠 ${MAX_INDIVIDUAL_TOOL_MESSAGES}. ⚙️ tool${MAX_INDIVIDUAL_TOOL_MESSAGES} — detail${MAX_INDIVIDUAL_TOOL_MESSAGES}`,
	});

	const overflowCalls = [...firstCalls, makeCall(MAX_INDIVIDUAL_TOOL_MESSAGES + 1)];
	assert.deepEqual(planLiveToolDelivery(overflowCalls, false), {
		type: "create-overflow",
		text: `🛠 More tools used:\n\n${MAX_INDIVIDUAL_TOOL_MESSAGES + 1}. ⚙️ tool${MAX_INDIVIDUAL_TOOL_MESSAGES + 1} — detail${MAX_INDIVIDUAL_TOOL_MESSAGES + 1}`,
	});

	const updatedOverflowCalls = [
		...overflowCalls,
		makeCall(MAX_INDIVIDUAL_TOOL_MESSAGES + 2),
	];
	assert.deepEqual(planLiveToolDelivery(updatedOverflowCalls, true), {
		type: "update-overflow",
		text: `🛠 More tools used:\n\n${MAX_INDIVIDUAL_TOOL_MESSAGES + 1}. ⚙️ tool${MAX_INDIVIDUAL_TOOL_MESSAGES + 1} — detail${MAX_INDIVIDUAL_TOOL_MESSAGES + 1}\n${MAX_INDIVIDUAL_TOOL_MESSAGES + 2}. ⚙️ tool${MAX_INDIVIDUAL_TOOL_MESSAGES + 2} — detail${MAX_INDIVIDUAL_TOOL_MESSAGES + 2}`,
	});
});
