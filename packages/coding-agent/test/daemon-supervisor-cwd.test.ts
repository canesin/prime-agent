import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";

const roots: string[] = [];
const supervisors: ChildProcess[] = [];
const clients: DaemonClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) {
		try {
			await client.request({ type: "shutdown", force: true }, 10_000);
		} finally {
			client.close();
		}
	}
	for (const child of supervisors.splice(0)) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		await new Promise<void>((done, reject) => {
			const timeout = setTimeout(() => reject(new Error("Supervisor did not stop")), 15_000);
			child.once("exit", () => {
				clearTimeout(timeout);
				done();
			});
		});
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function startSupervisor(root: string): Promise<DaemonClient> {
	const cwd = join(root, "cto");
	mkdirSync(cwd);
	const socketPath = join(root, "daemon.sock");
	const child = spawn(
		process.execPath,
		[
			resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs"),
			resolve(__dirname, "../src/cli.ts"),
			"--mode",
			"daemon",
			"--daemon-socket",
			socketPath,
			"--offline",
		],
		{
			cwd,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: join(root, "agent"),
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	supervisors.push(child);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(1000);
			clients.push(client);
			return client;
		} catch {
			client.close();
			if (child.exitCode !== null || child.signalCode !== null) break;
			await new Promise((done) => setTimeout(done, 25));
		}
	}
	throw new Error(`Supervisor startup failed: ${stderr}`);
}

describe("supervisor session working directories", () => {
	it.skipIf(process.platform === "win32")(
		"resumes after the supervisor directory is removed",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "prime-cwd-"));
			roots.push(root);
			const client = await startSupervisor(root);
			const projectDir = join(root, "project");
			mkdirSync(projectDir);
			const manager = SessionManager.create(projectDir, join(root, "agent", "sessions"));
			manager.appendMessage({ role: "user", content: "resume", timestamp: 1 });
			manager.flushNow();
			rmSync(join(root, "cto"), { recursive: true });

			const created = await client.request({
				type: "create",
				sessionPath: manager.getSessionFile(),
				config: { noTools: true, noExtensions: true },
			});
			expect(created).toMatchObject({ success: true, data: { cwd: projectDir } });
		},
		60_000,
	);

	it("resumes each project independently of the supervisor cwd and honors explicit overrides", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-cwd-"));
		roots.push(root);
		const client = await startSupervisor(root);
		const sessionDir = join(root, "agent", "sessions");
		for (const [project, override] of [
			["ibira", false],
			["go-alore", false],
			["override", true],
		] as const) {
			const projectDir = join(root, project);
			mkdirSync(projectDir);
			const manager = SessionManager.create(projectDir, sessionDir);
			manager.appendMessage({ role: "user", content: project, timestamp: 1 });
			manager.flushNow();
			const expectedCwd = override ? join(root, "cto") : projectDir;
			const created = await client.request({
				type: "create",
				sessionPath: manager.getSessionFile(),
				config: { noTools: true, noExtensions: true, ...(override ? { cwd: expectedCwd } : {}) },
			});
			expect(created).toMatchObject({
				success: true,
				data: { cwd: expectedCwd, sessionId: manager.getSessionId() },
			});
			const listed = await client.request({ type: "list" });
			expect(listed).toMatchObject({
				success: true,
				data: {
					sessions: expect.arrayContaining([
						expect.objectContaining({ sessionId: manager.getSessionId(), cwd: expectedCwd }),
					]),
				},
			});
			expect(SessionManager.open(manager.getSessionFile()!).getCwd()).toBe(projectDir);
		}
		const fresh = await client.request({
			type: "create",
			config: { noTools: true, noExtensions: true },
		});
		expect(fresh).toMatchObject({ success: true, data: { cwd: join(root, "cto") } });
		const freshExplicit = await client.request({
			type: "create",
			config: { noTools: true, noExtensions: true, cwd: join(root, "ibira") },
		});
		expect(freshExplicit).toMatchObject({ success: true, data: { cwd: join(root, "ibira") } });
	}, 60_000);
});
