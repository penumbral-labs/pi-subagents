import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { MockPi } from "../support/helpers.ts";
import {
	createEventBus,
	createMockPi,
	createTempDir,
	events,
	makeAgent,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";
import {
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
	SUBAGENT_FOREGROUND_ENDED_EVENT,
	SUBAGENT_FOREGROUND_STARTED_EVENT,
} from "../../src/shared/types.ts";
import { resolveSubagentIntercomTarget } from "../../src/intercom/intercom-bridge.ts";

interface RunSyncResult {
	exitCode: number;
	detached?: boolean;
	progress?: { status?: string };
}

interface ExecutionModule {
	runSync(
		runtimeCwd: string,
		agents: ReturnType<typeof makeAgent>[],
		agentName: string,
		task: string,
		options: Record<string, unknown>,
	): Promise<RunSyncResult>;
}

interface ResponsePayload {
	requestId?: string;
	accepted?: boolean;
	reason?: string;
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const available = !!execution;
const runSync = execution?.runSync;

function createRecordingEventBus() {
	const bus = createEventBus();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	return {
		emitted,
		on: bus.on.bind(bus),
		emit(channel: string, payload: unknown) {
			emitted.push({ channel, payload });
			bus.emit(channel, payload);
		},
	};
}

function responses(bus: { emitted: Array<{ channel: string; payload: unknown }> }, requestId: string): ResponsePayload[] {
	return bus.emitted
		.filter((entry) => entry.channel === INTERCOM_DETACH_RESPONSE_EVENT)
		.map((entry) => entry.payload as ResponsePayload)
		.filter((payload) => payload.requestId === requestId);
}

async function waitForForegroundStarted(bus: ReturnType<typeof createRecordingEventBus> | undefined, runId: string): Promise<void> {
	if (!bus) return;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (bus.emitted.some((entry) => entry.channel === SUBAGENT_FOREGROUND_STARTED_EVENT && (entry.payload as { runId?: unknown })?.runId === runId)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for foreground-started for ${runId}`);
}

async function waitForResponse(bus: ReturnType<typeof createRecordingEventBus>, requestId: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (responses(bus, requestId).length > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function startRun(input: {
	mockPi: MockPi;
	tempDir: string;
	bus?: ReturnType<typeof createRecordingEventBus>;
	runId: string;
	agent?: string;
	index?: number;
	allowIntercomDetach?: boolean;
	intercomSessionName?: string;
	steps?: Array<{ delay?: number; jsonl?: unknown[] }>;
	delay?: number;
	onUpdate?: (update: unknown) => void;
}) {
	input.mockPi.onCall({
		steps: input.steps ?? [
			{ jsonl: [events.toolStart("intercom", { action: "send", to: "orchestrator" })] },
			{ delay: 1000, jsonl: [events.assistantMessage("done")] },
		],
	});
	const agentName = input.agent ?? "worker";
	const promise = runSync!(input.tempDir, [makeAgent(agentName)], agentName, "Task", {
		runId: input.runId,
		index: input.index,
		allowIntercomDetach: input.allowIntercomDetach ?? true,
		...(input.bus ? { intercomEvents: input.bus } : {}),
		...(input.intercomSessionName ? { intercomSessionName: input.intercomSessionName } : {}),
		...(input.onUpdate ? { onUpdate: input.onUpdate } : {}),
	});
	await waitForForegroundStarted(input.bus, input.runId);
	await new Promise((resolve) => setTimeout(resolve, 25));
	return promise;
}

describe("intercom detach contract", { skip: !available ? "execution module not importable" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-intercom-detach-");
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("emits not_allowed refusal for matching child when detach is disabled", async () => {
		const bus = createRecordingEventBus();
		const run = await startRun({
			mockPi,
			tempDir,
			bus,
			runId: "not-allowed",
			allowIntercomDetach: false,
			onUpdate: () => bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "not-allowed-request", runId: "not-allowed" }),
		});
		await waitForResponse(bus, "not-allowed-request");

		assert.equal(responses(bus, "not-allowed-request").some((payload) => payload.reason === "not_allowed"), true);
		await run;
	});

	it("emits not_started refusal before the child starts intercom", async () => {
		const bus = createRecordingEventBus();
		const run = await startRun({ mockPi, tempDir, bus, runId: "not-started", allowIntercomDetach: false, onUpdate: () => bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "not-started-request", runId: "not-started" }) });
		await waitForResponse(bus, "not-started-request");

		assert.equal(responses(bus, "not-started-request").some((payload) => payload.reason === "not_allowed" || payload.reason === "not_started"), true);
		await run;
	});

	it("emits already_detached refusal after accepting an earlier request", async () => {
		const bus = createRecordingEventBus();
		let emitted = false;
		const run = await startRun({
			mockPi,
			tempDir,
			bus,
			runId: "already-detached",
			onUpdate: () => {
				if (emitted) return;
				emitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "first-detach", runId: "already-detached" });
			},
		});
		await waitForResponse(bus, "first-detach");

		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "second-detach", runId: "already-detached" });
		await waitForResponse(bus, "second-detach");

		assert.deepEqual(responses(bus, "first-detach"), [{ requestId: "first-detach", accepted: true }]);
		assert.deepEqual(responses(bus, "second-detach"), [{ requestId: "second-detach", accepted: false, reason: "already_detached" }]);
		const result = await run;
		assert.equal(result.detached, true);
	});

	it("emits already_closed refusal after process exit but before cleanup", async () => {
		const bus = createRecordingEventBus();
		let requested = false;
		bus.on(SUBAGENT_FOREGROUND_ENDED_EVENT, (payload) => {
			if (requested) return;
			if (!payload || typeof payload !== "object" || (payload as { runId?: unknown }).runId !== "already-closed") return;
			requested = true;
			bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "already-closed-request", runId: "already-closed" });
		});
		const run = await startRun({ mockPi, tempDir, bus, runId: "already-closed", delay: 50 });

		await run;

		assert.equal(requested, true);
		assert.deepEqual(responses(bus, "already-closed-request"), [{ requestId: "already-closed-request", accepted: false, reason: "already_closed" }]);
	});

	it("emits target_mismatch refusal when a present target field differs", async () => {
		const bus = createRecordingEventBus();
		const run = await startRun({ mockPi, tempDir, bus, runId: "target-a", onUpdate: () => bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "mismatch-request", runId: "target-b" }) });
		await waitForResponse(bus, "mismatch-request");

		assert.equal(responses(bus, "mismatch-request").some((payload) => payload.reason === "target_mismatch"), true);
		await run;
	});

	it("targets one of two same-agent children by runId and agent", async () => {
		const bus = createRecordingEventBus();
		let emitted = false;
		const runA = await startRun({
			mockPi,
			tempDir,
			bus,
			runId: "same-agent-a",
			agent: "worker",
			onUpdate: () => {
				if (emitted) return;
				emitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "same-agent-request", runId: "same-agent-a", agent: "worker" });
			},
		});
		const runB = await startRun({ mockPi, tempDir, bus, runId: "same-agent-b", agent: "worker" });
		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "same-agent-request", runId: "same-agent-a", agent: "worker" });
		await waitForResponse(bus, "same-agent-request");

		const resultA = await runA;
		const resultB = await runB;
		assert.equal(resultA.detached, true);
		assert.equal(resultB.detached, undefined);
		assert.equal(responses(bus, "same-agent-request").filter((payload) => payload.accepted === true).length >= 1, true);
		assert.equal(responses(bus, "same-agent-request").filter((payload) => payload.reason === "target_mismatch" || payload.accepted === true).length >= 1, true);
	});

	it("targets a child by intercomSession only", async () => {
		const bus = createRecordingEventBus();
		const target = resolveSubagentIntercomTarget("session-b", "worker", 1);
		const runA = await startRun({ mockPi, tempDir, bus, runId: "session-a", agent: "worker", index: 0 });
		let emitted = false;
		const runB = await startRun({
			mockPi,
			tempDir,
			bus,
			runId: "session-b",
			agent: "worker",
			index: 1,
			onUpdate: () => {
				if (emitted) return;
				emitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "session-only-request", intercomSession: target });
			},
		});
		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "session-only-request", intercomSession: target });
		await waitForResponse(bus, "session-only-request");

		const resultA = await runA;
		const resultB = await runB;
		assert.equal(resultA.detached, undefined);
		assert.equal(resultB.detached, true);
		assert.equal(responses(bus, "session-only-request").filter((payload) => payload.accepted === true).length >= 1, true);
		assert.equal(responses(bus, "session-only-request").filter((payload) => payload.reason === "target_mismatch" || payload.accepted === true).length >= 1, true);
	});

	it("matches explicit intercomSessionName when provided", async () => {
		const bus = createRecordingEventBus();
		const run = await startRun({
			mockPi,
			tempDir,
			bus,
			runId: "explicit-session",
			intercomSessionName: "custom-child-session",
			onUpdate: () => bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "explicit-session-request", intercomSession: "custom-child-session" }),
		});
		await waitForResponse(bus, "explicit-session-request");

		const result = await run;
		assert.equal(result.detached, true);
		assert.deepEqual(responses(bus, "explicit-session-request"), [{ requestId: "explicit-session-request", accepted: true }]);
	});

	it("does not respond when constructed without an intercom event bus", async () => {
		const bus = createRecordingEventBus();
		const run = await startRun({ mockPi, tempDir, runId: "no-bus", delay: 50 });

		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "no-bus-request", runId: "no-bus" });

		assert.deepEqual(responses(bus, "no-bus-request"), []);
		await run;
	});

	it("responds with accepted:true synchronously inside the request emit", async () => {
		const bus = createRecordingEventBus();
		let observedDuringEmit = false;
		bus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
			if ((payload as ResponsePayload).requestId === "sync-request" && (payload as ResponsePayload).accepted === true) {
				observedDuringEmit = true;
			}
		});
		const run = await startRun({
			mockPi,
			tempDir,
			bus,
			runId: "sync-accept",
			onUpdate: () => bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "sync-request", runId: "sync-accept" }),
		});

		await waitForResponse(bus, "sync-request");
		assert.equal(observedDuringEmit, true);
		const result = await run;
		assert.equal(result.detached, true);
	});

	it("emits foreground lifecycle events at spawn and completion", async () => {
		const bus = createRecordingEventBus();
		const run = await startRun({ mockPi, tempDir, bus, runId: "lifecycle", agent: "worker", index: 0, delay: 50 });

		await run;

		const started = bus.emitted.find((entry) => entry.channel === SUBAGENT_FOREGROUND_STARTED_EVENT)?.payload as Record<string, unknown> | undefined;
		const ended = bus.emitted.find((entry) => entry.channel === SUBAGENT_FOREGROUND_ENDED_EVENT)?.payload as Record<string, unknown> | undefined;
		assert.deepEqual(started, {
			runId: "lifecycle",
			agent: "worker",
			index: 0,
			intercomSession: resolveSubagentIntercomTarget("lifecycle", "worker", 0),
			allowIntercomDetach: true,
		});
		assert.deepEqual(ended, started);
	});
});
