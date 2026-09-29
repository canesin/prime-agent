import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	createDaemonCommandEnvelope,
	createDaemonEventMeta,
	createDaemonReplayInfo,
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_COMMAND_PLANE,
	DAEMON_COMMAND_TYPES,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_OUTBOUND_COMPATIBILITY,
	DAEMON_PROTOCOL_INFO,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
	getDaemonCommandCompatibilities,
	isDaemonCommandEnvelope,
	isSessionPlaneDaemonCommand,
	isSessionSummary,
	meetsDaemonCommandCompatibility,
	salvageDaemonCommandId,
	WORKER_DAEMON_COMMAND_TYPES,
} from "../src/modes/daemon/daemon-protocol.js";
import {
	type DaemonWorkerDescriptor,
	durableDaemonWorkerDescriptor,
} from "../src/modes/daemon/daemon-worker-protocol.js";

describe("daemon protocol helpers", () => {
	// One table for the static command-compatibility gates: protocol floor, schema revision,
	// capability name, and whether a default server advertises that capability.
	it.each([
		["delete_rlm_subagent", { minProtocol: 7, capability: "delete_rlm_subagent" }, true],
		["replace_acp_mcp_servers", { minProtocol: 7, minSchemaRevision: 22, capability: "acp_mcp_servers" }, true],
		["get_model_catalog", { minProtocol: 7, capability: "model_catalog" }, true],
		["mutate_queued_message", { minProtocol: 7, minSchemaRevision: 15, capability: "queue_message_mutation" }, true],
		["abort_and_send_queued", { minProtocol: 7, minSchemaRevision: 33, capability: "abort_and_send_queued" }, true],
		["get_rlm_max_depth_status", { minProtocol: 7, minSchemaRevision: 11 }, undefined],
		["set_rlm_max_depth", { minProtocol: 7, minSchemaRevision: 11 }, undefined],
		[
			"acquire_session_input_pause",
			{ minProtocol: 7, minSchemaRevision: 19, capability: "session_input_pause" },
			true,
		],
		[
			"release_session_input_pause",
			{ minProtocol: 7, minSchemaRevision: 19, capability: "session_input_pause" },
			true,
		],
		[
			"cancel_prompt_admission",
			{ minProtocol: 7, minSchemaRevision: 8, capability: "prompt_admission_cancellation" },
			true,
		],
		["get_rlm_children", { minProtocol: 7, minSchemaRevision: 17, capability: "authoritative_child_roster" }, true],
		["roster_subscribe", { minProtocol: 7, optionalMetadata: ["kernel_cwd"], capability: "agent_roster" }, undefined],
		["roster_unsubscribe", { minProtocol: 7, capability: "agent_roster" }, undefined],
		["heartbeats_list", { minProtocol: 7, capability: "heartbeat_catalog" }, true],
		["heartbeat_manage", { minProtocol: 7, capability: "heartbeat_management" }, true],
		["complete_owned_session", { minProtocol: 7, capability: "client_owned_sessions" }, true],
		// Only the supervisor issues transport tickets; workers and standalone daemons must not advertise it.
		[
			"get_direct_worker_transport",
			{ minProtocol: 7, minSchemaRevision: 25, capability: "direct_peer_transport" },
			false,
		],
	] as const)("gates %s", (command, expected, advertised) => {
		expect(DAEMON_COMMAND_COMPATIBILITY[command]).toEqual(expected);
		if (advertised === undefined) return;
		const capability = (expected as { capability: string }).capability;
		if (advertised) expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain(capability);
		else expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).not.toContain(capability);
	});

	// Field-conditional gates: the same command carries a higher floor only when an opt-in field is present.
	it.each([
		[
			"create without a telemetry policy",
			{ type: "create", config: { cwd: "/tmp" } },
			[{ minProtocol: 7, optionalMetadata: ["kernel_cwd"] }],
		],
		[
			"create carrying a telemetry policy",
			{ type: "create", config: { cwd: "/tmp", telemetryDisabled: true } },
			[
				{ minProtocol: 7, minSchemaRevision: 14 },
				{ minProtocol: 7, optionalMetadata: ["kernel_cwd"] },
			],
		],
		[
			"attach carrying a telemetry policy",
			{ type: "attach", activeSessionId: "active-1", telemetryDisabled: true },
			[
				{ minProtocol: 7, minSchemaRevision: 14 },
				{ minProtocol: 7, optionalMetadata: ["kernel_cwd"] },
			],
		],
		[
			"reattach carrying a telemetry policy",
			{ type: "reattach", activeSessionId: "active-1", targetActiveSessionId: "active-2", telemetryDisabled: true },
			[
				{ minProtocol: 7, minSchemaRevision: 14 },
				{ minProtocol: 7, optionalMetadata: ["kernel_cwd"] },
			],
		],
		[
			"attach carrying owned-session recovery context",
			{ type: "attach", activeSessionId: "active-1", recoveryConfig: { cwd: "/tmp/fresh-owner" } },
			[
				{ minProtocol: 7, minSchemaRevision: 17, capability: "owned_session_recovery_context" },
				{ minProtocol: 7, optionalMetadata: ["kernel_cwd"] },
			],
		],
		[
			"the headless completion barrier opting into RLM quiescence",
			{ type: "wait_for_headless_completion", activeSessionId: "active-1", waitForRlmQuiescence: true },
			[{ minProtocol: 7, minSchemaRevision: 18, capability: "rlm_quiescence_barrier" }, { minProtocol: 7 }],
		],
		[
			"the headless completion barrier without quiescence",
			{ type: "wait_for_headless_completion", activeSessionId: "active-1" },
			[{ minProtocol: 7 }],
		],
		[
			"cancellation without prompt ownership",
			{ type: "cancel_prompt_admission", activeSessionId: "active-1", admissionId: "a-1" },
			[{ minProtocol: 7, minSchemaRevision: 8, capability: "prompt_admission_cancellation" }],
		],
		[
			"cancellation after prompt ownership",
			{ type: "cancel_prompt_admission", activeSessionId: "active-1", admissionId: "a-1", cancelOwned: true },
			[
				{ minProtocol: 7, minSchemaRevision: 20, capability: "owned_prompt_cancellation" },
				{ minProtocol: 7, minSchemaRevision: 8, capability: "prompt_admission_cancellation" },
			],
		],
	])("gates %s", (_name, command, expected) => {
		expect(getDaemonCommandCompatibilities(command as DaemonCommand)).toEqual(expected);
	});

	it("serializes worker descriptors as identity-only version 2 state", () => {
		const descriptor = {
			version: 1,
			workerId: "worker",
			pid: 123,
			processStartId: "process-start",
			socketPath: "/tmp/worker.sock",
			recoveryJournalPath: "/state/recovery.jsonl",
			orphanProcessJournalPath: "/state/orphans.jsonl",
			supervisorSocketPath: "/tmp/supervisor.sock",
			authenticationToken: "local-worker-token",
			workerInstanceId: "instance-1",
			rootActiveSessionId: "active",
			sessionFile: "/sessions/root.jsonl",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			lifecycle: "ready",
			createCommand: {
				type: "create",
				sessionPath: "/sessions/root.jsonl",
				config: {
					sessionDir: "/legacy/sessions",
					telemetryDisabled: true,
					apiKey: "secret-api-key",
					extensionFlagValues: { providerSecretKey: "secret-extension" },
				},
				env: { PROVIDER_TOKEN: "secret-client-env" },
				launchEnv: { PROVIDER_TOKEN: "secret-launch-env" },
				runtimeMetadata: { parentActiveSessionId: "secret-runtime" },
			},
			launchEnv: { PROVIDER_TOKEN: "secret-top-level-env" },
			consecutiveFailures: 0,
			lastError: "secret-error",
		} as unknown as DaemonWorkerDescriptor;

		const durable = durableDaemonWorkerDescriptor(descriptor);

		expect(durable.version).toBe(2);
		expect(durable.createCommand).toEqual({ type: "create", sessionPath: "/sessions/root.jsonl" });
		expect(durable).toMatchObject({
			workerId: "worker",
			workerInstanceId: "instance-1",
			sessionFile: "/sessions/root.jsonl",
			sessionDir: "/legacy/sessions",
			telemetryDisabled: true,
		});
		expect(JSON.stringify(durable)).not.toContain("secret-");
	});

	it("keeps the advertised schema identity synchronized with wire type shapes", () => {
		const source = readFileSync(resolve(__dirname, "../src/modes/daemon/daemon-protocol.ts"), "utf8");
		const commandSource = source.slice(
			source.indexOf("export type DaemonCommand ="),
			source.indexOf("type DaemonCommandName"),
		);
		const savedSessionSource = source.slice(
			source.indexOf("export interface DaemonSavedSessionInfo"),
			source.indexOf("export type DaemonDeleteSavedSessionResult"),
		);
		const outboundSource = source.slice(
			source.indexOf("export type DaemonOutbound ="),
			source.indexOf("export const DAEMON_OUTBOUND_COMPATIBILITY"),
		);
		const digest = createHash("sha256")
			.update(`${commandSource}\n${savedSessionSource}\n${outboundSource}`)
			.digest("hex")
			.slice(0, 12);
		expect(DAEMON_SCHEMA_ID).toBe(`protocol-${DAEMON_PROTOCOL_VERSION}-schema-${DAEMON_SCHEMA_REVISION}-${digest}`);
	});

	it("capability- and schema-gates conditional RLM child cancellation", () => {
		const legacy = { type: "cancel_rlm_child", activeSessionId: "active-1", childId: "child-1" } as const;
		expect(getDaemonCommandCompatibilities(legacy)).toEqual([DAEMON_COMMAND_COMPATIBILITY.cancel_rlm_child]);
		expect(getDaemonCommandCompatibilities({ ...legacy, expectedRosterToken: "a".repeat(64) })).toEqual([
			{ minProtocol: 7, minSchemaRevision: 26, capability: "conditional_rlm_child_cancel" },
			DAEMON_COMMAND_COMPATIBILITY.cancel_rlm_child,
		]);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("conditional_rlm_child_cancel");
	});

	it("capability-gates guarded cron delivery without breaking legacy cron clients", () => {
		const legacyCron = {
			type: "cron_add",
			activeSessionId: "active-1",
			schedule: "in 1m",
			prompt: "legacy prompt",
		} as const satisfies DaemonCommand;
		const guardedCron = {
			...legacyCron,
			deliveryFence: {
				version: 1,
				activeSessionId: "active-1",
				messageCount: 4,
				lastActivityAt: "2026-08-31T12:00:00.000Z",
				taskState: "needs_input",
				goal: null,
			},
		} as DaemonCommand;

		expect(getDaemonCommandCompatibilities(legacyCron)).toEqual([{ minProtocol: 7 }]);
		expect(getDaemonCommandCompatibilities(guardedCron)).toEqual([
			{ minProtocol: 7, minSchemaRevision: 26, capability: "conditional_cron_delivery" },
			{ minProtocol: 7 },
		]);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("conditional_cron_delivery");
	});

	it("capability- and schema-gates conditional session profile changes", () => {
		expect((DAEMON_COMMAND_COMPATIBILITY as Record<string, unknown>).set_profile_if_idle).toEqual({
			minProtocol: 7,
			minSchemaRevision: 27,
			capability: "conditional_session_profile",
			optionalMetadata: ["kernel_cwd"],
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("conditional_session_profile");
	});

	it("creates versioned command envelopes and event meta", () => {
		const command = { id: "cmd-1", type: "attach", activeSessionId: "active-1" } as const;

		expect(createDaemonCommandEnvelope(command, "cmd-1", "client-1")).toEqual({
			type: "command",
			id: "cmd-1",
			protocol: DAEMON_PROTOCOL_INFO,
			clientId: "client-1",
			command,
		});
		expect(createDaemonEventMeta("active-1", 3, "2026-01-01T00:00:00.000Z")).toEqual({
			id: "active-1:3",
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId: "active-1",
			sequence: 3,
			cursor: { generation: "active-1", sequence: 3 },
			emittedAt: "2026-01-01T00:00:00.000Z",
		});
	});

	it("rejects command envelopes from pre-session-action protocols", () => {
		const command = { id: "cmd-1", type: "attach", activeSessionId: "active-1" } as const;

		expect(isDaemonCommandEnvelope(createDaemonCommandEnvelope(command, "cmd-1", "client-1", 7))).toBe(true);
		expect(isDaemonCommandEnvelope(createDaemonCommandEnvelope(command, "cmd-1", "client-1", 6))).toBe(false);
	});

	it("keeps Python directory metadata optional for new clients talking to older daemons", () => {
		const oldDaemon = { protocol: DAEMON_PROTOCOL_INFO, schemaRevision: 29, serverCapabilities: [] };
		for (const command of ["list", "create", "attach", "reattach", "rename", "get_state"] as const) {
			const compatibility = DAEMON_COMMAND_COMPATIBILITY[command];
			expect(compatibility.optionalMetadata).toContain("kernel_cwd");
			expect(meetsDaemonCommandCompatibility(oldDaemon, compatibility)).toBe(true);
		}
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(30);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("kernel_cwd");
		expect(DAEMON_OUTBOUND_COMPATIBILITY.roster_update.optionalMetadata).toContain("kernel_cwd");
	});

	it("keeps new daemon summaries readable by clients that only understand project cwd", () => {
		const summary = {
			id: "active-1",
			activeSessionId: "active-1",
			sessionId: "session-1",
			cwd: "/project",
			kernelCwd: "/project/nested",
		};
		expect(isSessionSummary(JSON.parse(JSON.stringify(summary)))).toBe(true);
		expect(summary.cwd).toBe("/project");
		expect(
			meetsDaemonCommandCompatibility(
				{ protocol: DAEMON_PROTOCOL_INFO, serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES },
				{ minProtocol: 7 },
			),
		).toBe(true);
	});

	it("classifies every command plane and never defaults unknown commands to the session plane", () => {
		// A worker "list" means only that worker's sessions; the supervisor list is authoritative.
		expect(DAEMON_COMMAND_PLANE.list).toBe("control");
		expect(DAEMON_COMMAND_PLANE.prompt).toBe("session");
		expect(DAEMON_COMMAND_PLANE.set_profile_if_idle).toBe("session");
		expect(isSessionPlaneDaemonCommand("no_such_command")).toBe(false);
	});

	it("admits every compatibility-table command, and workers reject only supervisor-only commands", () => {
		const supervisorOnly = [
			"complete_owned_session",
			"get_direct_worker_transport",
			"list_agent_peers",
			"promote_owned_session",
			"reattach",
			"roster_subscribe",
			"roster_unsubscribe",
		];
		const commands = Object.keys(DAEMON_COMMAND_COMPATIBILITY);
		expect([...DAEMON_COMMAND_TYPES]).toEqual(commands);
		expect([...WORKER_DAEMON_COMMAND_TYPES]).toEqual(commands.filter((command) => !supervisorOnly.includes(command)));
	});

	it("reports replay availability from resume cursors", () => {
		expect(createDaemonReplayInfo(undefined, 5, "generation-1")).toEqual({
			status: "complete",
			toSequence: 5,
			toCursor: { generation: "generation-1", sequence: 5 },
		});
		expect(
			createDaemonReplayInfo(
				{ activeSessionId: "active-1", generation: "generation-1", sequence: 5 },
				5,
				"generation-1",
			),
		).toEqual({
			status: "complete",
			fromSequence: 5,
			toSequence: 5,
			fromCursor: { generation: "generation-1", sequence: 5 },
			toCursor: { generation: "generation-1", sequence: 5 },
		});
		expect(createDaemonReplayInfo({ generation: "generation-1", sequence: 10 }, 5, "generation-1")).toEqual({
			status: "unavailable",
			fromSequence: 10,
			toSequence: 5,
			fromCursor: { generation: "generation-1", sequence: 10 },
			toCursor: { generation: "generation-1", sequence: 5 },
			reason: "resume_cursor_ahead_of_session",
		});
		expect(createDaemonReplayInfo({ generation: "generation-1", sequence: 2 }, 5, "generation-1")).toEqual({
			status: "unavailable",
			fromSequence: 2,
			toSequence: 5,
			fromCursor: { generation: "generation-1", sequence: 2 },
			toCursor: { generation: "generation-1", sequence: 5 },
			reason: "event_replay_not_available",
		});
		expect(createDaemonReplayInfo({ generation: "old", sequence: 5 }, 0, "new")).toMatchObject({
			status: "unavailable",
			reason: "event_generation_changed",
			fromCursor: { generation: "old", sequence: 5 },
			toCursor: { generation: "new", sequence: 0 },
		});
	});

	it("salvages command ids from rejected lines regardless of shape validity", () => {
		const oldEnvelope = JSON.stringify(
			createDaemonCommandEnvelope({ type: "list" } as DaemonCommand, "list-1", "old-client", 6),
		);
		expect(salvageDaemonCommandId(oldEnvelope)).toBe("list-1");
		expect(salvageDaemonCommandId(JSON.stringify({ type: "list", id: "bare-1" }))).toBe("bare-1");
		expect(salvageDaemonCommandId(JSON.stringify({ type: null, id: "typeless-1" }))).toBe("typeless-1");
		expect(salvageDaemonCommandId(JSON.stringify({ id: "no-type" }))).toBe("no-type");
		expect(salvageDaemonCommandId(JSON.stringify({ type: "command", id: 7 }))).toBeUndefined();
		expect(salvageDaemonCommandId(JSON.stringify("command"))).toBeUndefined();
		expect(salvageDaemonCommandId("{ not json")).toBeUndefined();
	});

	it("requires cwd before a wire payload counts as a session summary", () => {
		expect(isSessionSummary({ id: "worker-1", sessionId: "session-1", cwd: "/repo" })).toBe(true);
		expect(isSessionSummary({ id: "worker-1", sessionId: "session-1" })).toBe(false);
	});
});
