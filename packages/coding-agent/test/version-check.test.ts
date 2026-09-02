import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.js";

const defaultPrimeAgentDownloadBaseUrl = "https://github.com/canesin/prime-agent/releases/latest/download";
const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalOffline = process.env.PI_OFFLINE;
const originalPrimeAgentDownloadBaseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL;

function manifest(version: string) {
	const normalized = version.replace(/^v/, "");
	return {
		version,
		package: "prime-agent",
		tarball: `https://github.com/canesin/prime-agent/releases/download/v${normalized}/prime-agent-${normalized}.tgz`,
	};
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

afterEach(() => {
	vi.unstubAllGlobals();
	restoreEnv("PI_SKIP_VERSION_CHECK", originalSkipVersionCheck);
	restoreEnv("PI_OFFLINE", originalOffline);
	restoreEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", originalPrimeAgentDownloadBaseUrl);
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("0.70.5-beta.10.1.abcdef0", "0.70.5-beta.9.1.1234567")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json(manifest("v1.2.3")));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toBe("1.2.3");
	});

	it("uses the Prime Agent release manifest with a Prime Agent user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json(manifest("v1.2.4")));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			`${defaultPrimeAgentDownloadBaseUrl}/latest.json`,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^prime-agent\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("keeps beta installations on the beta release manifest", async () => {
		const fetchMock = vi.fn(async () => Response.json(manifest("v1.2.4-beta.124.1.abcdef0")));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.4-beta.123.1.1234567")).resolves.toBe("1.2.4-beta.124.1.abcdef0");
		expect(fetchMock).toHaveBeenCalledWith(`${defaultPrimeAgentDownloadBaseUrl}/beta.json`, expect.any(Object));
	});

	it("ignores the legacy release-base override", async () => {
		process.env.PRIME_AGENT_DOWNLOAD_BASE_URL = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";
		const fetchMock = vi.fn(async () => Response.json(manifest("v1.2.4")));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(`${defaultPrimeAgentDownloadBaseUrl}/latest.json`, expect.any(Object));
	});

	it("returns the active package and tarball install spec from the release manifest", async () => {
		const fetchMock = vi.fn(async () => Response.json(manifest("v1.2.4")));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			installSpec: "https://github.com/canesin/prime-agent/releases/download/v1.2.4/prime-agent-1.2.4.tgz",
			packageName: "prime-agent",
			version: "1.2.4",
		});
	});

	it.each([
		{ ...manifest("v1.2.4"), package: undefined },
		{ ...manifest("v1.2.4"), tarball: undefined },
		{ ...manifest("v1.2.4"), version: undefined },
		{ ...manifest("v1.2.4"), package: "@upstream/prime-agent" },
		{ ...manifest("v1.2.4"), package: " prime-agent" },
		{ packageName: "prime-agent", tarball: manifest("v1.2.4").tarball, version: "v1.2.4" },
		{ ...manifest("v1.2.4"), version: "latest" },
		manifest("vv1.2.4"),
		manifest("v1.2.4-"),
		manifest("v1.2.4-01"),
		manifest(" v1.2.4"),
		{ ...manifest("v1.2.4"), tarball: "releases/download/v1.2.4/prime-agent-1.2.4.tgz" },
		{
			...manifest("v1.2.4"),
			tarball: "https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v1.2.4/prime-agent-1.2.4.tgz",
		},
		{
			...manifest("v1.2.4"),
			tarball: "https://downloads.example.test/prime-agent/releases/download/v1.2.4/prime-agent-1.2.4.tgz",
		},
		{
			...manifest("v1.2.4"),
			tarball: "http://github.com/canesin/prime-agent/releases/download/v1.2.4/prime-agent-1.2.4.tgz",
		},
		{
			...manifest("v1.2.4"),
			tarball: "https://github.com/canesin/prime-agent/releases/download/v1.2.3/prime-agent-1.2.3.tgz",
		},
		{
			...manifest("v1.2.4"),
			tarball: "https://user@github.com/canesin/prime-agent/releases/download/v1.2.4/prime-agent-1.2.4.tgz",
		},
		{ ...manifest("v1.2.4"), tarball: `${manifest("v1.2.4").tarball}?replace=1` },
		{ ...manifest("v1.2.4"), tarball: `${manifest("v1.2.4").tarball}#replace` },
	])("rejects malformed or off-origin fork manifests", async (invalidManifest) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(invalidManifest)),
		);
		await expect(getLatestPiRelease("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
