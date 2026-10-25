/** A structural sigrun host double. Its service connector launches real
 * children so catalog tests cover the Web-stream transport, not just mocks. */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import type {
	HandlerContext,
	ServiceHandle,
	ServiceSpec,
	SigrunHost,
	UserService,
} from "../src/user-servers.js";

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
	readonly userTools: Map<string, ToolRegistration[]>;
	readonly actingUsers: Map<ConversationId, string>;
	readonly settings: Map<string, Record<string, unknown>>;
	readonly secrets: Map<string, Map<string, string>>;
	readonly launches: LaunchedService[];
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

export function createCatalogHost(): CatalogHostDouble {
	const userTools = new Map<string, ToolRegistration[]>();
	const actingUsers = new Map<ConversationId, string>();
	const settings = new Map<string, Record<string, unknown>>();
	const secrets = new Map<string, Map<string, string>>();
	const launches: LaunchedService[] = [];
	const live = new Map<string, LaunchedService>();
	let declarations: readonly UserService[] = [];

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
			},
		};
	};

	const host: SigrunHost = {
		tools: {
			setUserTools: (user, tools) => {
				userTools.set(user, [...tools]);
			},
		},
		services: { connect },
		stores: {
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
