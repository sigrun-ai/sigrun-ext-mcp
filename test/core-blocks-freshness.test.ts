import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { assertFreshCoreBlocks, createBlockBuildStamp } from "./core-blocks-freshness.js";

test("a deliberately stale sibling blocks build fails with a rebuild instruction", () => {
	const root = mkdtempSync(join(tmpdir(), "sigrun-mcp-stale-core-"));
	try {
		for (const dir of ["src/blocks", "shared/src/blocks", "dist/blocks"]) {
			mkdirSync(join(root, dir), { recursive: true });
		}
		writeFileSync(join(root, "src/blocks/index.ts"), "export const version = 1;\n");
		writeFileSync(join(root, "shared/src/blocks/index.ts"), "export type Block = unknown;\n");
		writeFileSync(
			join(root, "dist/blocks/build-stamp.json"),
			JSON.stringify(createBlockBuildStamp(root)),
		);
		expect(() => assertFreshCoreBlocks(root)).not.toThrow();
		writeFileSync(join(root, "src/blocks/index.ts"), "export const version = 2;\n");
		expect(() => assertFreshCoreBlocks(root)).toThrow(/Stale.*npm run build/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
