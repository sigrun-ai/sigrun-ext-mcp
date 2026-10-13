/**
 * The package bin entry (`sigrun-ext-mcp` → dist/bin.js): parse-and-run the
 * CLI, mapping the result to the process exit code. The body lives in
 * ./cli.ts so tests can exercise it without spawning a process.
 */
import { runCli } from "./cli.js";
void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
});
