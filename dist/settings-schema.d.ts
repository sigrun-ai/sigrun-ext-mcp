/**
 * The MCP extension's declared settings schemas (settings rework, Task 11):
 * the operator's server registry moves out of `mcp.json` into the shared
 * `servers` table (keyed by server name) plus the `userServers` policy,
 * and the per-user catalog toggles and user-defined servers move into
 * `userSchema`. Header and env VALUES are `writeOnly` — they live in the
 * secrets store under `servers/<name>/headers/<Header>` (resp. `env/<KEY>`),
 * never in the settings file.
 *
 * Authored as raw JSON Schema (the generator's contract), not TypeBox:
 * TypeBox 1.3's `Type.Object` wraps `additionalProperties` as a nested
 * property, which the generator cannot read as a table.
 *
 * The schema cannot express every config rule; `config.ts` keeps the
 * cross-field rules (shared credentials require a sharedAuthority, a users
 * allowlist only makes sense for shared entries, enabled/disabled must not
 * contradict, OAuth needs its three endpoints, only S256 PKCE is
 * implemented) applied after the checked read. The name rules (reserved
 * `servers`, no `u_` prefix, no `.` or `/`) are documented on
 * `propertyNames` for the form and enforced by the parser.
 */
export declare const MCP_SETTINGS_JSON_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly servers: {
            readonly type: "object";
            readonly additionalProperties: {
                readonly oneOf: readonly [{
                    readonly type: "object";
                    readonly title: "Remote (URL)";
                    readonly properties: {
                        readonly credentials: {
                            readonly oneOf: readonly [{
                                readonly const: "user";
                                readonly title: "Per-user";
                            }, {
                                readonly const: "shared";
                                readonly title: "Shared operator authority";
                            }];
                            readonly default: "user";
                        };
                        readonly sharedAuthority: {
                            readonly type: "string";
                            readonly description: "Why lending this shared authority to other users is acceptable (required for shared credentials).";
                        };
                        readonly users: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly description: "Allowlist of directory users for a shared entry.";
                        };
                        readonly availability: {
                            readonly oneOf: readonly [{
                                readonly const: "all";
                                readonly title: "Enabled for everyone";
                            }, {
                                readonly const: "opt-in";
                                readonly title: "Opt-in per user";
                            }];
                            readonly default: "all";
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                            readonly default: true;
                            readonly description: "Clear to skip this server entirely.";
                        };
                        readonly exposure: {
                            readonly oneOf: readonly [{
                                readonly const: "codemode";
                                readonly title: "Codemode (scripts only)";
                            }, {
                                readonly const: "deferred";
                                readonly title: "Deferred (tool_search)";
                            }, {
                                readonly const: "direct";
                                readonly title: "Direct (model-offered)";
                            }, {
                                readonly const: "hidden";
                                readonly title: "Hidden (not registered)";
                            }];
                            readonly default: "codemode";
                        };
                        readonly toolExposure: {
                            readonly type: "object";
                            readonly additionalProperties: {
                                readonly oneOf: readonly [{
                                    readonly const: "codemode";
                                    readonly title: "Codemode (scripts only)";
                                }, {
                                    readonly const: "deferred";
                                    readonly title: "Deferred (tool_search)";
                                }, {
                                    readonly const: "direct";
                                    readonly title: "Direct (model-offered)";
                                }, {
                                    readonly const: "hidden";
                                    readonly title: "Hidden (not registered)";
                                }];
                                readonly default: "codemode";
                            };
                            readonly description: "Per-tool exposure overrides: exact tool names beat patterns; the first matching *-pattern wins.";
                        };
                        readonly timeout: {
                            readonly type: "number";
                            readonly minimum: 0.001;
                            readonly description: "Per-request wire timeout in seconds (default 60).";
                        };
                        readonly transport: {
                            readonly const: "url";
                        };
                        readonly url: {
                            readonly type: "string";
                            readonly pattern: "^https?://";
                            readonly description: "The streamable-HTTP endpoint (legacy SSE negotiated on first contact).";
                        };
                        readonly headers: {
                            readonly type: "object";
                            readonly additionalProperties: {
                                readonly type: "string";
                                readonly writeOnly: true;
                            };
                            readonly description: "Extra request headers; values are secrets stored in the secrets store.";
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly title: "Stdio (command)";
                    readonly properties: {
                        readonly credentials: {
                            readonly oneOf: readonly [{
                                readonly const: "user";
                                readonly title: "Per-user";
                            }, {
                                readonly const: "shared";
                                readonly title: "Shared operator authority";
                            }];
                            readonly default: "user";
                        };
                        readonly sharedAuthority: {
                            readonly type: "string";
                            readonly description: "Why lending this shared authority to other users is acceptable (required for shared credentials).";
                        };
                        readonly users: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly description: "Allowlist of directory users for a shared entry.";
                        };
                        readonly availability: {
                            readonly oneOf: readonly [{
                                readonly const: "all";
                                readonly title: "Enabled for everyone";
                            }, {
                                readonly const: "opt-in";
                                readonly title: "Opt-in per user";
                            }];
                            readonly default: "all";
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                            readonly default: true;
                            readonly description: "Clear to skip this server entirely.";
                        };
                        readonly exposure: {
                            readonly oneOf: readonly [{
                                readonly const: "codemode";
                                readonly title: "Codemode (scripts only)";
                            }, {
                                readonly const: "deferred";
                                readonly title: "Deferred (tool_search)";
                            }, {
                                readonly const: "direct";
                                readonly title: "Direct (model-offered)";
                            }, {
                                readonly const: "hidden";
                                readonly title: "Hidden (not registered)";
                            }];
                            readonly default: "codemode";
                        };
                        readonly toolExposure: {
                            readonly type: "object";
                            readonly additionalProperties: {
                                readonly oneOf: readonly [{
                                    readonly const: "codemode";
                                    readonly title: "Codemode (scripts only)";
                                }, {
                                    readonly const: "deferred";
                                    readonly title: "Deferred (tool_search)";
                                }, {
                                    readonly const: "direct";
                                    readonly title: "Direct (model-offered)";
                                }, {
                                    readonly const: "hidden";
                                    readonly title: "Hidden (not registered)";
                                }];
                                readonly default: "codemode";
                            };
                            readonly description: "Per-tool exposure overrides: exact tool names beat patterns; the first matching *-pattern wins.";
                        };
                        readonly timeout: {
                            readonly type: "number";
                            readonly minimum: 0.001;
                            readonly description: "Per-request wire timeout in seconds (default 60).";
                        };
                        readonly transport: {
                            readonly const: "command";
                        };
                        readonly command: {
                            readonly type: "string";
                            readonly minLength: 1;
                            readonly description: "The executable to spawn.";
                        };
                        readonly args: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                            readonly default: readonly [];
                        };
                        readonly env: {
                            readonly type: "object";
                            readonly additionalProperties: {
                                readonly type: "string";
                                readonly writeOnly: true;
                            };
                            readonly description: "Extra environment for the child; values are secrets stored in the secrets store.";
                        };
                        readonly oauth: {
                            readonly type: "object";
                            readonly title: "OAuth";
                            readonly properties: {
                                readonly authorizeUrl: {
                                    readonly type: "string";
                                    readonly description: "The authorization endpoint (browser).";
                                };
                                readonly tokenUrl: {
                                    readonly type: "string";
                                    readonly description: "The token endpoint (code exchange).";
                                };
                                readonly clientId: {
                                    readonly type: "string";
                                    readonly description: "The registered OAuth client id.";
                                };
                                readonly scopes: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly codeChallengeMethod: {
                                    readonly type: "string";
                                    readonly description: 'Only "S256" is implemented.';
                                };
                            };
                        };
                    };
                }];
                readonly "x-sigrun-summary": readonly ["transport", "credentials", "exposure"];
            };
            readonly propertyNames: {
                readonly pattern: "^(?!servers$)(?!u_)[^./]+$";
                readonly description: 'Server name: not the reserved "servers", no "u_" prefix, no "." or "/".';
            };
            readonly default: {};
            readonly description: "The operator's MCP server registry, keyed by server name.";
        };
        readonly userServers: {
            readonly oneOf: readonly [{
                readonly const: "none";
                readonly title: "None (operator servers only)";
            }, {
                readonly const: "remote";
                readonly title: "Remote (URL) servers";
            }, {
                readonly const: "all";
                readonly title: "All (URL and stdio)";
            }];
            readonly default: "none";
            readonly "x-sigrun-apply": "live";
            readonly description: "Whether users may define their own MCP servers.";
        };
    };
};
/** Per-user settings: the user's own servers (the `u_`-prefixed catalog
 * entries' source) and the flat per-operator-server enablement toggles
 * (`settings[serverName]`, read by catalogEnabledFromSettings). Declaring
 * the toggles as boolean-valued additional properties keeps TODAY'S shape
 * — there is no second `toggles` key — and gives those values the same
 * checked read as the server definitions. */
export declare const MCP_USER_JSON_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: {
        readonly type: "boolean";
        readonly "x-sigrun-apply": "live";
        readonly description: "Whether this operator-provided MCP server is enabled for you.";
    };
    readonly properties: {
        readonly servers: {
            readonly type: "object";
            readonly additionalProperties: {
                readonly oneOf: readonly [{
                    readonly type: "object";
                    readonly title: "Remote (URL)";
                    readonly properties: {
                        readonly credentials: {
                            readonly oneOf: readonly [{
                                readonly const: "user";
                                readonly title: "Per-user";
                            }, {
                                readonly const: "shared";
                                readonly title: "Shared operator authority";
                            }];
                            readonly default: "user";
                        };
                        readonly sharedAuthority: {
                            readonly type: "string";
                            readonly description: "Why lending this shared authority to other users is acceptable (required for shared credentials).";
                        };
                        readonly users: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly description: "Allowlist of directory users for a shared entry.";
                        };
                        readonly availability: {
                            readonly oneOf: readonly [{
                                readonly const: "all";
                                readonly title: "Enabled for everyone";
                            }, {
                                readonly const: "opt-in";
                                readonly title: "Opt-in per user";
                            }];
                            readonly default: "all";
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                            readonly default: true;
                            readonly description: "Clear to skip this server entirely.";
                        };
                        readonly exposure: {
                            readonly oneOf: readonly [{
                                readonly const: "codemode";
                                readonly title: "Codemode (scripts only)";
                            }, {
                                readonly const: "deferred";
                                readonly title: "Deferred (tool_search)";
                            }, {
                                readonly const: "direct";
                                readonly title: "Direct (model-offered)";
                            }, {
                                readonly const: "hidden";
                                readonly title: "Hidden (not registered)";
                            }];
                            readonly default: "codemode";
                        };
                        readonly toolExposure: {
                            readonly type: "object";
                            readonly additionalProperties: {
                                readonly oneOf: readonly [{
                                    readonly const: "codemode";
                                    readonly title: "Codemode (scripts only)";
                                }, {
                                    readonly const: "deferred";
                                    readonly title: "Deferred (tool_search)";
                                }, {
                                    readonly const: "direct";
                                    readonly title: "Direct (model-offered)";
                                }, {
                                    readonly const: "hidden";
                                    readonly title: "Hidden (not registered)";
                                }];
                                readonly default: "codemode";
                            };
                            readonly description: "Per-tool exposure overrides: exact tool names beat patterns; the first matching *-pattern wins.";
                        };
                        readonly timeout: {
                            readonly type: "number";
                            readonly minimum: 0.001;
                            readonly description: "Per-request wire timeout in seconds (default 60).";
                        };
                        readonly transport: {
                            readonly const: "url";
                        };
                        readonly url: {
                            readonly type: "string";
                            readonly pattern: "^https?://";
                            readonly description: "The streamable-HTTP endpoint (legacy SSE negotiated on first contact).";
                        };
                        readonly headers: {
                            readonly type: "object";
                            readonly additionalProperties: {
                                readonly type: "string";
                                readonly writeOnly: true;
                            };
                            readonly description: "Extra request headers; values are secrets stored in the secrets store.";
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly title: "Stdio (command)";
                    readonly properties: {
                        readonly credentials: {
                            readonly oneOf: readonly [{
                                readonly const: "user";
                                readonly title: "Per-user";
                            }, {
                                readonly const: "shared";
                                readonly title: "Shared operator authority";
                            }];
                            readonly default: "user";
                        };
                        readonly sharedAuthority: {
                            readonly type: "string";
                            readonly description: "Why lending this shared authority to other users is acceptable (required for shared credentials).";
                        };
                        readonly users: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly description: "Allowlist of directory users for a shared entry.";
                        };
                        readonly availability: {
                            readonly oneOf: readonly [{
                                readonly const: "all";
                                readonly title: "Enabled for everyone";
                            }, {
                                readonly const: "opt-in";
                                readonly title: "Opt-in per user";
                            }];
                            readonly default: "all";
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                            readonly default: true;
                            readonly description: "Clear to skip this server entirely.";
                        };
                        readonly exposure: {
                            readonly oneOf: readonly [{
                                readonly const: "codemode";
                                readonly title: "Codemode (scripts only)";
                            }, {
                                readonly const: "deferred";
                                readonly title: "Deferred (tool_search)";
                            }, {
                                readonly const: "direct";
                                readonly title: "Direct (model-offered)";
                            }, {
                                readonly const: "hidden";
                                readonly title: "Hidden (not registered)";
                            }];
                            readonly default: "codemode";
                        };
                        readonly toolExposure: {
                            readonly type: "object";
                            readonly additionalProperties: {
                                readonly oneOf: readonly [{
                                    readonly const: "codemode";
                                    readonly title: "Codemode (scripts only)";
                                }, {
                                    readonly const: "deferred";
                                    readonly title: "Deferred (tool_search)";
                                }, {
                                    readonly const: "direct";
                                    readonly title: "Direct (model-offered)";
                                }, {
                                    readonly const: "hidden";
                                    readonly title: "Hidden (not registered)";
                                }];
                                readonly default: "codemode";
                            };
                            readonly description: "Per-tool exposure overrides: exact tool names beat patterns; the first matching *-pattern wins.";
                        };
                        readonly timeout: {
                            readonly type: "number";
                            readonly minimum: 0.001;
                            readonly description: "Per-request wire timeout in seconds (default 60).";
                        };
                        readonly transport: {
                            readonly const: "command";
                        };
                        readonly command: {
                            readonly type: "string";
                            readonly minLength: 1;
                            readonly description: "The executable to spawn.";
                        };
                        readonly args: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                            readonly default: readonly [];
                        };
                        readonly env: {
                            readonly type: "object";
                            readonly additionalProperties: {
                                readonly type: "string";
                                readonly writeOnly: true;
                            };
                            readonly description: "Extra environment for the child; values are secrets stored in the secrets store.";
                        };
                        readonly oauth: {
                            readonly type: "object";
                            readonly title: "OAuth";
                            readonly properties: {
                                readonly authorizeUrl: {
                                    readonly type: "string";
                                    readonly description: "The authorization endpoint (browser).";
                                };
                                readonly tokenUrl: {
                                    readonly type: "string";
                                    readonly description: "The token endpoint (code exchange).";
                                };
                                readonly clientId: {
                                    readonly type: "string";
                                    readonly description: "The registered OAuth client id.";
                                };
                                readonly scopes: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly codeChallengeMethod: {
                                    readonly type: "string";
                                    readonly description: 'Only "S256" is implemented.';
                                };
                            };
                        };
                    };
                }];
                readonly "x-sigrun-summary": readonly ["transport", "credentials", "exposure"];
            };
            readonly propertyNames: {
                readonly pattern: "^(?!servers$)(?!u_)[^./]+$";
                readonly description: 'Server name: not the reserved "servers", no "u_" prefix, no "." or "/".';
            };
            readonly default: {};
            readonly "x-sigrun-apply": "live";
            readonly description: "Your own MCP servers, keyed by server name.";
        };
    };
};
