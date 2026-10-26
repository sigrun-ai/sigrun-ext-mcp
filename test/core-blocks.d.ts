declare module "@sigrun/sigrun/blocks" {
	export function validateTree(
		tree: unknown,
		options: {
			readonly placement: "settings";
			readonly handlers: ReadonlySet<string>;
		},
	): { readonly ok: boolean; readonly errors?: readonly { readonly path: string; readonly message: string }[] };
}
