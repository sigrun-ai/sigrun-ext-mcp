/** Resolve core's blocks export and reject output built from other sources. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

export interface BlockBuildStamp {
	readonly algorithm: "sha256";
	readonly sources: Readonly<Record<string, string>>;
}

function sourceFiles(coreRoot: string): string[] {
	const blocks = join(coreRoot, "src", "blocks");
	const files = readdirSync(blocks, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name));
	files.push(join(coreRoot, "shared", "src", "blocks", "index.ts"));
	return files.sort();
}

export function createBlockBuildStamp(coreRoot: string): BlockBuildStamp {
	return {
		algorithm: "sha256",
		sources: Object.fromEntries(sourceFiles(coreRoot).map((path) => [
			relative(coreRoot, path).replaceAll("\\", "/"),
			createHash("sha256").update(readFileSync(path)).digest("hex"),
		])),
	};
}

export function assertFreshCoreBlocks(coreRoot?: string): void {
	let root = coreRoot;
	if (root === undefined) {
		const require = createRequire(import.meta.url);
		root = resolve(dirname(require.resolve("@sigrun/sigrun/blocks")), "..", "..");
	}
	const rebuild = `Run npm run build in ${root} before running the MCP block-validator tests.`;
	const stampPath = join(root, "dist", "blocks", "build-stamp.json");
	if (!existsSync(stampPath)) {
		throw new Error(`Missing or stale @sigrun/sigrun blocks build stamp. ${rebuild}`);
	}
	const built = JSON.parse(readFileSync(stampPath, "utf8")) as BlockBuildStamp;
	const current = createBlockBuildStamp(root);
	if (JSON.stringify(built) !== JSON.stringify(current)) {
		throw new Error(`Stale @sigrun/sigrun blocks build: source inputs differ from ${stampPath}. ${rebuild}`);
	}
}
