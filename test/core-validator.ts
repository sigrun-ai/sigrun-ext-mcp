// The development-only sibling checkout provides core's built validator;
// this module keeps its external path out of production and test types.
const validatorPath = new URL("../../sigrun/dist/blocks/index.js", import.meta.url).href;
const { validateTree } = await import(/* @vite-ignore */ validatorPath) as {
	validateTree(
		tree: unknown,
		options: {
			readonly placement: "settings";
			readonly handlers: ReadonlySet<string>;
		},
	): { readonly ok: boolean; readonly errors?: readonly { readonly path: string; readonly message: string }[] };
};

export { validateTree };
