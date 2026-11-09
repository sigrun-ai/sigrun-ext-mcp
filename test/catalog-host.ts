/** A structural sigrun host double. Its service connector launches real
 * children so catalog tests cover the Web-stream transport, not just mocks. */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import { checkStoredSettings } from "@sigrun/sigrun/settings-schema";
import type {
	HandlerContext,
	ServiceHandle,
	ServiceSpec,
	SigrunHost,
	UserService,
} from "../src/user-servers.js";

/** The shared (operator) settings/secrets double: the scoped stores the
 * settings-rework factory declares against. Secret values are filled into
 * `writeOnly` slots on read by walking the schema, mirroring core's
 * checked read (the real seam host does this through the generated form's
 * secret patterns; the double only needs the mcp schema's two tables). */
export interface SharedStoresDouble {
	readonly settings: Map<string, unknown>;
	readonly secrets: Map<string, string>;
	readonly notices: { readonly user: string; readonly key?: string; readonly title: string; readonly body?: string }[];
	readonly users: { user: string; admin?: boolean; createdAt?: number }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fill `writeOnly` slots from the shared secrets map, following the
 * schema's table/variant structure (a simplified core fillSecrets). */
function fillSecrets(
	schema: Record<string, unknown>,
	value: unknown,
	path: readonly string[],
	secrets: ReadonlyMap<string, string>,
): unknown {
	if (schema.writeOnly === true) {
		const key = path.join("/");
		const stored = secrets.get(key);
		if (stored !== undefined) return stored;
		return value ?? "";
	}
	if (Array.isArray(schema.oneOf) && isRecord(value)) {
		for (const branch of schema.oneOf) {
			if (!isRecord(branch)) continue;
			const properties = isRecord(branch.properties) ? branch.properties : {};
			const discriminator = Object.entries(properties).find(
				([, child]) => isRecord(child) && typeof child.const === "string",
			) as [string, Record<string, unknown>] | undefined;
			if (discriminator !== undefined && value[discriminator[0]] === discriminator[1].const) {
				return fillSecrets(branch, value, path, secrets);
			}
		}
		return value;
	}
	if (schema.type === "object" && isRecord(value)) {
		const result: Record<string, unknown> = { ...value };
		const additional = schema.additionalProperties;
		if (isRecord(additional)) {
			for (const [key, child] of Object.entries(result)) {
				result[key] = fillSecrets(additional, child, [...path, key], secrets);
			}
		}
		const properties = isRecord(schema.properties) ? schema.properties : {};
		for (const [name, child] of Object.entries(properties)) {
			if (!isRecord(child)) continue;
			if (result[name] !== undefined) {
				result[name] = fillSecrets(child, result[name], [...path, name], secrets);
			} else if (child.writeOnly === true) {
				result[name] = fillSecrets(child, undefined, [...path, name], secrets);
			}
		}
		return result;
	}
	return value;
}

export interface LaunchedService {
	readonly name: string;
	readonly user: string;
	readonly child: ChildProcessWithoutNullStreams;
	readonly spec: ServiceSpec;
	readonly exited: Promise<{ code: number | null; signal: string | null }>;
	releases: number;
}

export interface CatalogHostDouble {
	readonly host: SigrunHost;
	declarePerUserTools(): void;
	readonly userTools: Map<string, ToolRegistration[]>;
	readonly actingUsers: Map<ConversationId, string>;
	readonly settings: Map<string, Record<string, unknown>>;
	readonly secrets: Map<string, Map<string, string>>;
	readonly launches: LaunchedService[];
	readonly shared: SharedStoresDouble;
	setSharedSettings(value: Record<string, unknown>): void;
	registerServices(services: readonly UserService[]): void;
	setSettings(user: string, value: Record<string, unknown>): void;
	setSecret(user: string, key: string, value: string): void;
	close(): void;
}

function outputStream(
	stream: NodeJS.ReadableStream,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			stream.on("data", (chunk: Buffer) => {
				controller.enqueue(new Uint8Array(chunk));
			});
			stream.on("end", () => controller.close());
			stream.on("error", (error) => controller.error(error));
		},
	});
}

export function createCatalogHost(options: {
	readonly stopOnLastRelease?: boolean;
} = {}): CatalogHostDouble {
	const userTools = new Map<string, ToolRegistration[]>();
	const actingUsers = new Map<ConversationId, string>();
	const settings = new Map<string, Record<string, unknown>>();
	const secrets = new Map<string, Map<string, string>>();
	const launches: LaunchedService[] = [];
	const live = new Map<string, LaunchedService>();
	let declarations: readonly UserService[] = [];
	let perUserToolsDeclared = false;
	const shared: SharedStoresDouble = {
		settings: new Map<string, unknown>(),
		secrets: new Map<string, string>(),
		notices: [],
		users: [{ user: "alice", admin: true, createdAt: 0 }],
	};

	const connect = async (
		name: string,
		user: string,
		ctx: HandlerContext,
	): Promise<ServiceHandle> => {
		const key = `${name}\0${user}`;
		let launched = live.get(key);
		if (launched === undefined) {
			const declaration = declarations.find((item) => item.name === name);
			if (declaration === undefined) throw new Error(`unknown service ${name}`);
			const spec = await declaration.start(user, ctx);
			if (spec === undefined) throw new Error("service disabled");
			const child = spawn(spec.command, [...spec.args], {
				env: spec.env,
				cwd: spec.cwd,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const exited = new Promise<{ code: number | null; signal: string | null }>(
				(resolve) => {
					child.once("error", () => resolve({ code: null, signal: null }));
					child.once("exit", (code, signal) => resolve({ code, signal }));
				},
			);
			launched = { name, user, child, spec, exited, releases: 0 };
			launches.push(launched);
			live.set(key, launched);
		}
		let released = false;
		return {
			stdin: new WritableStream<Uint8Array>({
				write: (chunk) =>
					new Promise<void>((resolve, reject) => {
						launched.child.stdin.write(chunk, (error) => {
							if (error === null || error === undefined) resolve();
							else reject(error);
						});
					}),
				close: async () => {
					launched.child.stdin.end();
				},
				abort: async (reason) => {
					launched.child.stdin.destroy(reason as Error);
				},
			}),
			stdout: outputStream(launched.child.stdout),
			stderr: outputStream(launched.child.stderr),
			exited: launched.exited,
			release: () => {
				if (released) return;
				released = true;
				launched.releases += 1;
				if (options.stopOnLastRelease === true && live.get(key) === launched) {
					// Core stops an unheld service after its idle timer; immediate
					// disposal models that transition without slowing this test.
					live.delete(key);
					launched.child.kill("SIGTERM");
				}
			},
		};
	};

	const sharedSecrets = {
		get: async (key: string) => shared.secrets.get(key),
		set: async (key: string, value: string) => {
			shared.secrets.set(key, value);
		},
		delete: async (key: string) => {
			shared.secrets.delete(key);
		},
	};
	const sharedSettings = {
		get: async () => Object.fromEntries(shared.settings),
		set: async (value: Record<string, unknown>) => {
			shared.settings.clear();
			for (const [key, entry] of Object.entries(value)) shared.settings.set(key, entry);
		},
	};

	const host: SigrunHost = {
		settings: {
			declare: (decl: {
				readonly schema: Readonly<Record<string, unknown>>;
				readonly userSchema?: Readonly<Record<string, unknown>>;
			}) => ({
				get: async () => {
					const checked = checkStoredSettings(
						decl.schema,
						Object.fromEntries(shared.settings),
					).value;
					return fillSecrets(decl.schema, checked, [], shared.secrets) as Record<string, unknown>;
				},
				user: (user: string) => ({
					get: async () => {
						if (decl.userSchema === undefined) {
							throw new Error("settings.userSchema is not declared");
						}
						return checkStoredSettings(
							decl.userSchema,
							{ ...(settings.get(user) ?? {}) },
						).value;
					},
				}),
			}),
		},
		users: {
			list: async () => shared.users,
		},
		notices: {
			post: async (input: { user: string; key?: string; title: string; body?: string }) => {
				shared.notices.push(input);
				return { id: `notice-${shared.notices.length}` };
			},
		},
		tools: {
			setUserTools: (user, tools) => {
				if (!perUserToolsDeclared) throw new Error("perUserTools not declared");
				userTools.set(user, [...tools]);
			},
		},
		services: { connect },
		stores: {
			secrets: sharedSecrets,
			settings: sharedSettings,
			user: (user) => ({
				secrets: {
					get: async (key) => secrets.get(user)?.get(key),
					set: async (key, value) => {
						const values = secrets.get(user) ?? new Map<string, string>();
						values.set(key, value);
						secrets.set(user, values);
					},
					delete: async (key) => {
						secrets.get(user)?.delete(key);
					},
				},
				settings: {
					get: async () => ({ ...(settings.get(user) ?? {}) }),
					set: async (value) => {
						settings.set(user, { ...value });
					},
				},
				paths: { data: "/tmp/data", state: "/tmp/state", cache: "/tmp/cache" },
			}),
		},
		identity: {
			actingUser: async (conversationId) => actingUsers.get(conversationId),
		},
	};

	return {
		host,
		userTools,
		actingUsers,
		settings,
		secrets,
		launches,
		shared,
		setSharedSettings: (value) => {
			shared.settings.clear();
			for (const [key, entry] of Object.entries(value)) shared.settings.set(key, entry);
		},
		declarePerUserTools: () => {
			perUserToolsDeclared = true;
		},
		registerServices: (services) => {
			declarations = services;
		},
		setSettings: (user, value) => {
			settings.set(user, value);
		},
		setSecret: (user, key, value) => {
			const values = secrets.get(user) ?? new Map<string, string>();
			values.set(key, value);
			secrets.set(user, values);
		},
		close: () => {
			for (const launched of launches) {
				if (launched.child.exitCode === null && launched.child.signalCode === null) {
					launched.child.kill("SIGTERM");
				}
			}
		},
	};
}
