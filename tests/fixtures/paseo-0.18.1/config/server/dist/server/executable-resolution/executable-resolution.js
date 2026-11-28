import { constants as fsConstants, existsSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { execCommand } from "../utils/spawn.js";
import which from "which";
import { windowsExecutableResolution } from "./windows.js";
const PROBE_TIMEOUT_MS = 2000;
function hasPathSeparator(value) {
    return value.includes("/") || value.includes("\\");
}
function stripWindowsPathQuotes(entry) {
    return process.platform === "win32" &&
        entry.length >= 2 &&
        entry.startsWith('"') &&
        entry.endsWith('"')
        ? entry.slice(1, -1)
        : entry;
}
function normalizeDirectory(dir) {
    const resolved = resolve(dir);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function extractAbsolutePathDirs(rawPath) {
    if (!rawPath) {
        return [];
    }
    return rawPath
        .split(delimiter)
        .map(stripWindowsPathQuotes)
        .filter((entry) => entry.length > 0 && isAbsolute(entry));
}
async function enumerateCandidates(name, env, probe = true) {
    const rawPath = env?.PATH !== undefined ? env.PATH : process.env.PATH;
    const absolutePathDirs = extractAbsolutePathDirs(rawPath);
    if (absolutePathDirs.length === 0) {
        return [];
    }
    const filteredEnv = {
        ...(env ?? process.env),
        PATH: absolutePathDirs.join(delimiter),
    };
    const allowedDirs = new Set(absolutePathDirs.map(normalizeDirectory));
    const candidates = probe && process.platform !== "win32" && existsSync("/usr/bin/which")
        ? await enumerateCandidatesViaSystemWhich(name, filteredEnv)
        : await enumerateCandidatesViaLibrary(name, filteredEnv);
    return candidates.filter((candidate) => allowedDirs.has(normalizeDirectory(dirname(candidate))));
}
async function enumerateCandidatesViaSystemWhich(name, env) {
    try {
        const { stdout } = await execCommand("/usr/bin/which", ["-a", name], {
            baseEnv: env,
            timeout: 3000,
            killSignal: "SIGKILL",
        });
        return Array.from(new Set(stdout.trim().split("\n").filter(Boolean)));
    }
    catch (error) {
        // which exits 1 for a missing command. A failed lookup is not evidence of absence.
        if (error instanceof Error && "code" in error && error.code === 1)
            return [];
        throw error;
    }
}
async function enumerateCandidatesViaLibrary(name, env) {
    let candidates;
    try {
        candidates = await which(name, { all: true, path: env?.PATH, pathExt: env?.PATHEXT });
    }
    catch (error) {
        // `which` throws ENOENT when the command is absent from PATH.
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    const seen = new Set();
    return candidates.filter((candidate) => {
        if (seen.has(candidate)) {
            return false;
        }
        seen.add(candidate);
        return true;
    });
}
export async function probeExecutable(executablePath, options = PROBE_TIMEOUT_MS) {
    const { probeTimeoutMs: timeoutMs = PROBE_TIMEOUT_MS, env } = typeof options === "number" ? { probeTimeoutMs: options } : options;
    try {
        await execCommand(executablePath, ["--version"], {
            baseEnv: env,
            timeout: timeoutMs,
            killSignal: "SIGKILL",
            maxBuffer: 64 * 1024,
        });
        return true;
    }
    catch (error) {
        return classifyProbeError(error);
    }
}
function classifyProbeError(error) {
    const err = error;
    if (err.killed) {
        return true;
    }
    if (typeof err.code === "number") {
        return true;
    }
    if (err.code === "ENOENT" ||
        err.code === "EACCES" ||
        err.code === "ENOEXEC" ||
        err.code === "UNKNOWN") {
        return false;
    }
    return false;
}
/**
 * Check a literal executable path. PATH search is handled by findExecutable().
 */
export function executableExists(executablePath, exists = existsSync) {
    if (process.platform === "win32") {
        return windowsExecutableResolution.exists(executablePath, { exists });
    }
    return exists(executablePath) ? executablePath : null;
}
// PATH lookup that never runs the candidate, unlike findExecutable which probes
// each one with `--version`. A terminal spawn path cannot afford that probe: it
// would execute the profile command once before the terminal even opens.
// `path` overrides the PATH to search, so a caller can resolve against the
// environment its child process will actually get rather than the daemon's own.
export async function findExecutableWithoutProbing(name, options) {
    if (!name) {
        return null;
    }
    const path = options.path === undefined
        ? undefined
        : options.path
            .split(delimiter)
            .map((entry) => resolve(options.cwd, entry))
            .join(delimiter);
    const candidates = await enumerateCandidatesViaLibrary(name, { PATH: path });
    return candidates[0] ?? null;
}
async function isLocalExecutable(candidate) {
    try {
        const info = await stat(candidate);
        if (!info.isFile())
            return false;
        if (process.platform !== "win32") {
            await access(candidate, fsConstants.X_OK);
        }
        return true;
    }
    catch {
        return false;
    }
}
export async function findExecutable(name, options = PROBE_TIMEOUT_MS) {
    const { probeTimeoutMs = PROBE_TIMEOUT_MS, env, probe = true, } = typeof options === "number" ? { probeTimeoutMs: options } : options;
    const trimmed = name.trim();
    if (!trimmed) {
        return null;
    }
    const checkCandidate = probe
        ? (command, timeout) => probeExecutable(command, { probeTimeoutMs: timeout, env })
        : (command) => isLocalExecutable(command);
    if (process.platform === "win32") {
        return windowsExecutableResolution.find(trimmed, {
            enumeratePathCandidates: (command) => enumerateCandidates(command, env, probe),
            probeExecutable: checkCandidate,
            exists: existsSync,
            localAppData: env?.LOCALAPPDATA,
            probeTimeoutMs,
        });
    }
    if (hasPathSeparator(trimmed)) {
        return (await checkCandidate(trimmed, probeTimeoutMs)) ? trimmed : null;
    }
    const candidates = await enumerateCandidates(trimmed, env, probe);
    for (const candidate of candidates) {
        if (await checkCandidate(candidate, probeTimeoutMs)) {
            return candidate;
        }
    }
    return null;
}
export async function isCommandAvailable(command) {
    return (await findExecutable(command)) !== null;
}
//# sourceMappingURL=executable-resolution.js.map