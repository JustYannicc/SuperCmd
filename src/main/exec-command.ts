import * as fs from 'fs';
import { execFileSync as defaultExecFileSync, spawn as defaultSpawn } from 'child_process';

export type ExecCommandOptions = {
  shell?: boolean | string;
  input?: string;
  env?: Record<string, string>;
  cwd?: string;
};

export type ExecCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type ExecCommandProcess = {
  stdout?: {
    on(event: 'data', listener: (data: Buffer) => void): void;
  };
  stderr?: {
    on(event: 'data', listener: (data: Buffer) => void): void;
  };
  stdin?: {
    write(input: string): void;
    end(): void;
  };
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  kill(): unknown;
};

type ExecFileSyncLike = (
  file: string,
  args?: readonly string[],
  options?: Record<string, unknown>
) => string | Buffer;

type ExecCommandDependencies = {
  spawn?: (command: string, args: string[], options: Record<string, unknown>) => ExecCommandProcess;
  execFileSync?: ExecFileSyncLike;
  existsSync?: (path: fs.PathLike) => boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

const EXEC_COMMAND_TIMEOUT_MS = 300000;

function resolveExecutablePath(input: string, dependencies: Required<Pick<ExecCommandDependencies, 'execFileSync' | 'existsSync'>>): string {
  if (!input || typeof input !== 'string') return input;
  if (!input.includes('/') && !input.includes('\\')) return input;
  if (!input.startsWith('/')) return input;
  if (dependencies.existsSync(input)) return input;
  try {
    const base = input.split('/').filter(Boolean).pop() || '';
    if (!base) return input;
    const lookup = String(
      dependencies.execFileSync(
        '/bin/zsh',
        ['-lc', `command -v -- ${JSON.stringify(base)} 2>/dev/null || true`],
        { encoding: 'utf-8' }
      )
    ).trim();
    if (lookup && dependencies.existsSync(lookup)) return lookup;
  } catch {}
  return input;
}

export function runExecCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions,
  dependencies: ExecCommandDependencies = {}
): Promise<ExecCommandResult> {
  const spawn = dependencies.spawn ?? defaultSpawn;
  const execFileSync = dependencies.execFileSync ?? defaultExecFileSync;
  const existsSync = dependencies.existsSync ?? fs.existsSync.bind(fs);
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd.bind(process);
  const scheduleTimeout = dependencies.setTimeout ?? setTimeout;
  const cancelTimeout = dependencies.clearTimeout ?? clearTimeout;

  return new Promise((resolve) => {
    try {
      const normalizedCommand = resolveExecutablePath(command, { execFileSync, existsSync });
      // Augment PATH so extensions can find brew, npm, nvm, etc. even when
      // the app is launched from the Dock (where macOS strips the login PATH).
      const extraPaths = [
        '/opt/homebrew/bin', '/opt/homebrew/sbin',
        '/usr/local/bin', '/usr/local/sbin',
        '/usr/bin', '/usr/sbin', '/bin', '/sbin',
      ];
      const currentPath = (options?.env?.PATH ?? env.PATH ?? '');
      const augmentedPath = [
        ...extraPaths,
        ...currentPath.split(':').filter(Boolean),
      ].filter((v, i, a) => a.indexOf(v) === i).join(':');
      const spawnOptions: Record<string, unknown> = {
        shell: options?.shell ?? false,
        env: { ...env, ...options?.env, PATH: augmentedPath },
        cwd: options?.cwd || cwd(),
      };

      const proc = options?.shell
        ? spawn([normalizedCommand, ...args].join(' '), [], { ...spawnOptions, shell: true })
        : spawn(normalizedCommand, args, spawnOptions);

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;

      const finish = (result: ExecCommandResult) => {
        if (settled) return;
        settled = true;
        if (timeout) {
          cancelTimeout(timeout);
          timeout = null;
        }
        resolve(result);
      };

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      if (options?.input && proc.stdin) {
        proc.stdin.write(options.input);
        proc.stdin.end();
      }

      proc.on('close', (code: number | null) => {
        finish({ stdout, stderr, exitCode: code ?? 0 });
      });

      proc.on('error', (err: Error) => {
        finish({ stdout, stderr: err.message, exitCode: 1 });
      });

      // Timeout after 5 minutes - allows long-running commands (brew install, npm install, etc.)
      timeout = scheduleTimeout(() => {
        try {
          proc.kill();
        } catch {}
        finish({ stdout, stderr: stderr || 'Command timed out', exitCode: 124 });
      }, EXEC_COMMAND_TIMEOUT_MS);
    } catch (e: any) {
      resolve({ stdout: '', stderr: e?.message || 'Failed to execute command', exitCode: 1 });
    }
  });
}
