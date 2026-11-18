/**
 * Host-contract conformance (handback A5): this package keeps a NARROW
 * structural mirror of core's host (`src/user-servers.ts` `SigrunHost`,
 * `DeclaredSettingsMirror`) so its test doubles implement only what the
 * extension uses. The mirror must never describe a different shape than
 * core's real host — these type-level assertions fail `npm run typecheck`
 * the moment core's `@sigrun/sigrun/extension` types stop satisfying it
 * (a renamed member, a changed signature, a removed method).
 */

import { expectTypeOf, test } from "vitest";
import type {
	DeclaredSettings,
	SigrunHost as CoreSigrunHost,
} from "@sigrun/sigrun/extension";
import type { DeclaredSettingsMirror, SigrunHost } from "../src/user-servers.js";

test("core's real host satisfies the mirrored host contract", () => {
	expectTypeOf<CoreSigrunHost>().toExtend<SigrunHost>();
	expectTypeOf<
		DeclaredSettings<Record<string, unknown>, Record<string, unknown>>
	>().toExtend<DeclaredSettingsMirror>();
});
