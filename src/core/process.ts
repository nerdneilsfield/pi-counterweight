/**
 * 通用进程运行器：把一条命令跑成以自己为组长的独立进程组，超时或取消时先对整个进程组发 SIGTERM，
 * 5 秒宽限后升级为 SIGKILL，组内进程全部消失后本 Promise 才 resolve。
 *
 * The generic process runner: a command is spawned detached as its own
 * process-group leader. Timeout or caller abort SIGTERMs the whole group first,
 * SIGKILL follows after the grace period, and the promise resolves only after
 * every group member is gone — so no late child can keep writing while the
 * caller moves on. Used by the end check, `cw observe`, and the explorer.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";

/** SIGTERM 后留给进程组的退出宽限期，超时才升级为 SIGKILL。 / Grace period after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5_000;
/** 等待整个进程组消失时的轮询间隔 / Poll interval while waiting for the whole group to exit. */
const GROUP_POLL_MS = 50;

/**
 * 一次进程运行的结果：退出码、终止信号、超时与取消标志、启动错误，以及释放信号监听的句柄。
 *
 * One process run: exit code, terminal signal, timeout and cancel flags, a
 * launch error, and the handle that releases the parent-signal listener.
 */
export interface ProcessRun {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /**
   * 是否被取消；在 `dispose` 之前保持实时跟踪，因此也覆盖进程退出后才到达的取消。
   *
   * Live: stays true-tracking until `dispose` for cancels landing after exit.
   */
  readonly cancelled: boolean;
  /**
   * 进程从未真正启动时写入（spawn 失败或命令为空）。
   *
   * Set when the process never started (spawn failure or empty command).
   */
  runnerError: string | null;
  /**
   * 调用方不再读取 `cancelled` 之后，释放父信号监听。
   *
   * Release the parent-signal listener once the caller stops reading `cancelled`.
   */
  dispose(): void;
}

/**
 * 在 `cwd` 里把 `cmd` 跑成独立进程组，stdout/stderr 写入给定日志文件；同名的日志文件已存在即失败（`wx`），避免覆盖别人的输出。
 *
 * Runs `cmd` detached as its own process-group leader inside `cwd`, with
 * stdout/stderr into the given log files. The log files are opened with `wx`,
 * so an existing file fails rather than being overwritten.
 *
 * @param options - 命令 argv、工作目录、环境、超时、日志路径与可选的取消信号。
 * @returns 退出码、终止信号、超时/取消标志、启动错误与释放信号监听的 `dispose`。
 * @remarks
 * 命令为空或 spawn 失败时不会留下任何进程：退出码为 null，原因写进 `runnerError`。信号一律发给整个
 * 进程组（`-pid`），而不是单个 pid，所以命令派生的子进程不会在调用方开始处理结果之后继续写输出。
 *
 * An empty command or a failed spawn leaves no process behind: the exit code
 * is null and the reason lands in `runnerError`. Signals always go to the
 * whole group (`-pid`), never a single pid.
 */
export async function runProcess(options: {
  cwd: string;
  cmd: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
  signal?: AbortSignal;
}): Promise<ProcessRun> {
  const stdout = await open(options.stdoutPath, "wx");
  const stderr = await open(options.stderrPath, "wx");
  const abort = linkAbort(options.signal, options.timeoutMs);
  let child: ChildProcess | undefined;
  let watch: ChildWatch | undefined;
  let runnerError: string | null = null;
  try {
    if (!abort.signal.aborted && options.cmd.length > 0) {
      child = spawn(options.cmd[0]!, options.cmd.slice(1), {
        cwd: options.cwd,
        detached: true,
        stdio: ["ignore", stdout.fd, stderr.fd],
        env: options.env,
      });
      watch = watchChild(child);
    } else if (options.cmd.length === 0) {
      runnerError = "command empty";
    }
  } catch (error) {
    runnerError = error instanceof Error ? error.message : "failed to start";
  } finally {
    await stdout.close();
    await stderr.close();
  }
  const stop = watch ? await stopGroup(watch, abort) : { exitCode: null, signal: null };
  // The timeout is decided once the group is gone, but the parent-signal
  // listener must survive the return: a cancel landing while the caller reads
  // and reports the result has to stay visible through `cancelled`. The caller
  // releases the listener via `dispose` when it stops reading it.
  abort.cancelTimer();
  const failure = runnerError ?? watch?.state.spawnError ?? null;
  return {
    exitCode: failure === null ? stop.exitCode : null,
    signal: stop.signal,
    timedOut: abort.timedOut,
    get cancelled() { return abort.cancelled; },
    runnerError: failure,
    dispose: () => abort.dispose(),
  };
}

interface StopResult {
  exitCode: number | null;
  signal: string | null;
}

/**
 * 把调用方的取消信号与超时合成为一个信号，同时保留两种起因：`cancelled` 跟踪父信号，`timedOut`
 * 只跟踪定时器。
 *
 * Merges the caller's abort signal with a timeout into a single signal while
 * keeping the two causes distinguishable: `cancelled` tracks the parent signal
 * and stays live until `dispose`, `timedOut` tracks the timer. The timer is
 * cleared once the group is gone so a finished run is never marked as timed
 * out; the parent listener lives until `dispose` releases it.
 */
function linkAbort(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cancelled: boolean;
  timedOut: boolean;
  cancelTimer: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const state = { cancelled: parent?.aborted === true, timedOut: false };
  const onParent = () => {
    state.cancelled = true;
    controller.abort();
  };
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onParent, { once: true });
  }
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    get cancelled() { return state.cancelled; },
    get timedOut() { return state.timedOut; },
    cancelTimer() { clearTimeout(timer); },
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

/**
 * 子进程早期的生命周期状态；`leader` 在 `spawn`、`error`、`exit` 中先到的那个事件上完成，值为 pid。
 *
 * Early child lifecycle state. `leader` settles on whichever of `spawn`,
 * `error`, or `exit` fires first — the value is the child pid — so a caller
 * that awaits it can never miss an event that already happened.
 */
interface ChildWatch {
  leader: Promise<number | undefined>;
  state: { exited: boolean; code: number | null; signal: string | null; spawned: boolean; spawnError: string | null };
}

/**
 * spawn 之后立刻同步挂上生命周期监听：父进程先关日志句柄，监听若等到 stopGroup 里才挂就会漏事件。
 *
 * Attach lifecycle listeners synchronously right after spawn. The parent closes
 * the log-file handles before awaiting anything else; a listener attached only
 * inside stopGroup could miss the `spawn` or `exit` event entirely. An `error`
 * before `spawn` is the async spawn failure (e.g. ENOENT): its message is
 * captured for the caller instead of degrading to a bare exit code.
 */
function watchChild(child: ChildProcess): ChildWatch {
  const state = {
    exited: false, code: null as number | null, signal: null as string | null,
    spawned: false, spawnError: null as string | null,
  };
  let resolveLeader!: (pid: number | undefined) => void;
  const leader = new Promise<number | undefined>((resolve) => { resolveLeader = resolve; });
  child.once("spawn", () => {
    state.spawned = true;
    resolveLeader(child.pid);
  });
  child.once("error", (error: Error) => {
    if (!state.spawned) state.spawnError = error.message;
    resolveLeader(child.pid);
  });
  child.once("exit", (code, signal) => {
    state.exited = true;
    state.code = code;
    state.signal = signal;
    resolveLeader(child.pid);
  });
  return { leader, state };
}

/**
 * 先等出组长的 pid，然后一直等到整个进程组消失：取消或超时一到就对 `-pid` 发 SIGTERM，宽限期
 * 过后补 SIGKILL。
 *
 * Waits for the leader pid, then blocks until the whole process group is gone.
 * An aborted signal — caller cancel or timeout — SIGTERMs `-pid` at once and
 * follows with SIGKILL after the grace period, so a command that spawned
 * helpers cannot leave grandchildren writing while the caller moves on.
 * Polling stands in for the missing portable "group exited" notification; when
 * spawn never produced a pid, the recorded exit state is returned with exit
 * code 1 as the fallback.
 */
async function stopGroup(watch: ChildWatch, abort: { signal: AbortSignal }): Promise<StopResult> {
  const leader = await watch.leader;
  if (leader === undefined) return { exitCode: watch.state.code ?? 1, signal: watch.state.signal };
  let termSent = false;
  let killSent = false;
  let killAt = 0;
  const arm = () => {
    if (termSent) return;
    termSent = true;
    killAt = Date.now() + KILL_GRACE_MS;
    signalGroup(leader, "SIGTERM");
  };
  if (abort.signal.aborted) arm();
  else abort.signal.addEventListener("abort", arm, { once: true });
  while (!watch.state.exited || groupAlive(leader)) {
    if (abort.signal.aborted) arm();
    if (termSent && !killSent && Date.now() >= killAt) {
      killSent = true;
      signalGroup(leader, "SIGKILL");
    }
    await delay(GROUP_POLL_MS);
  }
  abort.signal.removeEventListener("abort", arm);
  return { exitCode: watch.state.code, signal: watch.state.signal };
}

/**
 * 向整个进程组（`-pid`）发送信号；组已经不在了就静默忽略。
 *
 * Signals the whole process group via `-pid`. ESRCH and EPERM both mean the
 * group is gone — macOS reports EPERM for an already-exited group — and are
 * swallowed because this runs from an abort listener, where a throw would
 * surface as an uncaught exception. Other errors propagate.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : "";
    // The group belongs to this process's own detached child, so a same-uid
    // live group cannot refuse the signal. macOS reports EPERM instead of
    // ESRCH for an already-exited group; both mean it is gone.
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

/**
 * 进程组里是否还有活着的进程：ESRCH 说明组已消失；EPERM 说明探测被拒、无法证明组已消失，于是按
 * “仍活着”处理；其他错误向上抛。
 *
 * Whether the process group still has a live member: ESRCH means it is gone,
 * EPERM means the probe was refused and nothing proves it is gone — treated as
 * alive — and other errors propagate.
 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : "";
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
