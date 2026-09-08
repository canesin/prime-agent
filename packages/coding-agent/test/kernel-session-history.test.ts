import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createSessionHistoryHandlers } from "../src/core/session-history.js";
import { SessionManager } from "../src/core/session-manager.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

const runtimeSource = fileURLToPath(new URL("../../../prime-agent-runtime/src", import.meta.url));
const python = [
	process.env.PRIME_AGENT_KERNEL_PYTHON,
	join(runtimeSource, "..", ".venv", "bin", "python"),
	join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
].find(
	(candidate) =>
		candidate &&
		existsSync(candidate) &&
		spawnSync(candidate, ["-c", "import rlm.repl, dill"], {
			env: { ...process.env, PYTHONPATH: runtimeSource },
		}).status === 0,
);

it.skipIf(!python)(
	"exposes archived history through rlm.history after kernel and session restart",
	async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-history-"));
		let provisioner: IpythonKernelProvisioner | undefined;
		try {
			let session = SessionManager.create(tempDir, join(tempDir, "sessions"));
			const content = "remember archived-value 資料🚀";
			const oldId = session.appendMessage({ role: "user", content, timestamp: 1 });
			session.appendMessage(fauxAssistantMessage("recorded"));
			const boundary = session.appendCustomEntry("compaction_boundary", {});
			session.appendCompaction("checkpoint", boundary, 1000);
			const path = session.getSessionFile()!;
			for (let restart = 0; restart < 2; restart++) {
				provisioner = new IpythonKernelProvisioner(tempDir, {
					python,
					hostHandlers: createSessionHistoryHandlers(session),
					env: { PYTHONPATH: runtimeSource },
				});
				const kernel = await provisioner.ensure();
				const result = await kernel.execute(`
import json
hits = await rlm.history.search("archived-value", limit=1)
page = await rlm.history.read(hits["entries"][0]["id"])
chunks, offset = [], 0
while offset is not None:
    part = await rlm.history.read(page["id"], offset=offset, max_chars=1)
    chunks.append(part["json"])
    offset = part["next_offset"]
assert json.loads("".join(chunks))["message"]["content"] == ${JSON.stringify(content)}
print(json.dumps({"id": page["id"], "content": json.loads(page["json"])["message"]["content"]}))
`);
				expect(result.status, JSON.stringify(result)).toBe("ok");
				expect(JSON.parse(result.stdout.trim())).toEqual({ id: oldId, content });
				await provisioner.dispose();
				provisioner = undefined;
				session = SessionManager.open(path);
			}
		} finally {
			await provisioner?.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	},
	60000,
);
