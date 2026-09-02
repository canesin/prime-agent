#!/usr/bin/env node

import { pathToFileURL } from "node:url";

function releaseKey(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)-cto\.(\d+)\.(\d+)$/.exec(version);
	return match?.slice(1).map(Number);
}

export function shouldMarkLatest(candidate, current) {
	const candidateKey = releaseKey(candidate);
	if (!candidateKey) throw new Error(`Invalid candidate fork release version: ${candidate}`);
	if (!current) return true;
	const currentKey = releaseKey(current);
	if (!currentKey) return false;
	for (let index = 0; index < candidateKey.length; index += 1) {
		if (candidateKey[index] !== currentKey[index]) return candidateKey[index] > currentKey[index];
	}
	return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const latest = shouldMarkLatest(process.argv[2] ?? "", process.argv[3] ?? "");
	process.stdout.write(`flag=${latest ? "--latest" : "--latest=false"}\n`);
}
