/**
 * 最高危一级的 shell 命令：递归强制删根或家目录、强制推送 main/master、mkfs、dd 写设备。
 * 按未加引号的 `;`、`&`、`&&`、`||`、`|`、括号、换行切段，逐段判断；引号里的文本只是参数，不算命令。
 * `bash -c`、命令替换、变量拼接不处理：这不是安全边界，只拦模型手滑写出的字面命令。
 * 两个仓库里这个文件逐字节相同，不引用任何宿主。
 *
 * The highest-risk shell commands only. Segments are split on unquoted separators and judged one by one;
 * quoted text is an argument, not a command. `bash -c`, substitution and variable assembly are not handled,
 * so this is not a security boundary. Byte-identical in both repositories.
 */

import { homedir } from "node:os";
import { git } from "./gitstate.js";

/** 把命令切成段，每段是去掉引号后的词。 */
function segments(command: string): string[][] {
  const result: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  const endWord = (): void => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) result.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) word += command[++i]!;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < command.length) {
      i += 1;
      if (command[i] !== "\n") {
        word += command[i]!;
        started = true;
      }
    } else if (char === ";" || char === "\n") {
      endSegment();
    } else if (char === "|") {
      if (command[i + 1] === "|") i += 1;
      endSegment();
    } else if (char === "&") {
      if (command[i + 1] === "&") {
        i += 1;
        endSegment();
      } else if (command[i - 1] === ">" || command[i + 1] === ">") {
        // `2>&1` 和 `&>` 是重定向，不是后台运行。
        word += char;
        started = true;
      } else {
        endSegment();
      }
    } else if (char === "(" || char === ")") {
      endSegment();
    } else if (char === " " || char === "\t") {
      endWord();
    } else {
      word += char;
      started = true;
    }
  }
  endSegment();
  return result;
}

const WRAPPERS = new Set([
  "sudo", "doas", "env", "command", "nohup", "time", "exec", "nice",
  "if", "then", "elif", "else", "while", "until", "do", "!", "{",
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** 跳过环境变量赋值和 sudo 之类的前缀，返回真正的命令词和它的参数。 */
function commandOf(words: string[]): { name: string; args: string[] } | null {
  let i = 0;
  for (;;) {
    while (i < words.length && ASSIGNMENT.test(words[i]!)) i += 1;
    const name = words[i]?.split("/").pop();
    if (name === undefined) return null;
    if (!WRAPPERS.has(name)) return { name, args: words.slice(i + 1) };
    const wrapper = name;
    i += 1;
    while (i < words.length && (words[i]!.startsWith("-") || ASSIGNMENT.test(words[i]!))) {
      const consumesNext = (wrapper === "sudo" || wrapper === "doas") && (words[i] === "-u" || words[i] === "-g");
      i += consumesNext ? 2 : 1;
    }
  }
}

/** `/`、`/*`、`~`、`$HOME`、`${HOME}` 和家目录的绝对路径，含结尾斜杠、`/.` 和 `/*` 的写法。 */
function isRootOrHome(target: string): boolean {
  let value = target.replace("${HOME}", "$HOME");
  if (value.endsWith("/*")) value = value.slice(0, -1);
  value = value.replace(/(\/\.?)+$/, "");
  if (value === "") return target.startsWith("/");
  return value === "~" || value === "$HOME" || value === homedir().replace(/\/+$/, "");
}

const HARMLESS_DEVICES = new Set(["/dev/null", "/dev/zero", "/dev/stdout", "/dev/stderr"]);

function dangerousRm(args: string[]): string | null {
  let recursive = false;
  let force = false;
  const targets: string[] = [];
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") options = false;
    else if (options && arg.startsWith("--")) {
      if (arg === "--recursive") recursive = true;
      if (arg === "--force") force = true;
    } else if (options && arg.startsWith("-") && arg.length > 1) {
      if (/[rR]/.test(arg)) recursive = true;
      if (arg.includes("f")) force = true;
    } else {
      targets.push(arg);
    }
  }
  const hit = targets.find(isRootOrHome);
  return recursive && force && hit !== undefined ? `递归强制删除 ${hit}` : null;
}

/** `branch` 是当前分支，用来判断没写目标分支或写 `HEAD` 的推送；未知时为 null。 */
function dangerousPush(args: string[], branch: string | null): string | null {
  // 跳过 git 的全局选项，找到子命令。
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  if (args[i] !== "push") return null;
  let force = false;
  const refs: string[] = [];
  for (const arg of args.slice(i + 1)) {
    if (arg === "--force") force = true;
    else if (arg.startsWith("--")) continue;
    else if (arg.startsWith("-")) force ||= arg.includes("f");
    else refs.push(arg);
  }
  for (const ref of refs) {
    if (ref.startsWith("+")) force = true;
  }
  // 第一个位置参数是远端名，后面才是 refspec。
  const destinations = refs.slice(1).map((ref) => ref.replace(/^\+/, "").split(":").pop()!.replace(/^refs\/heads\//, ""));
  const hit = (destinations.length === 0 ? [branch] : destinations.map((target) => target === "HEAD" ? branch : target))
    .find((target) => target === "main" || target === "master");
  return force && hit !== undefined ? `强制推送 ${hit}` : null;
}

/** 返回拒绝理由；不是最高危命令返回 null。 */
export function dangerousCommand(command: string, branch: string | null = null): string | null {
  for (const words of segments(command)) {
    const found = commandOf(words);
    if (found === null) continue;
    const { name, args } = found;
    let reason: string | null = null;
    if (name === "rm") reason = dangerousRm(args);
    else if (name === "git") reason = dangerousPush(args, branch);
    else if (name.startsWith("mkfs")) reason = "mkfs 会重写整个设备";
    else if (name === "dd") {
      const target = args.find((arg) => arg.startsWith("of=/dev/"));
      if (target !== undefined && !HARMLESS_DEVICES.has(target.slice(3))) reason = `dd 写入设备 ${target.slice(3)}`;
    }
    if (reason !== null) return `[counterweight] 拒绝高危命令：${reason}。如确需执行，请由用户手动运行。`;
  }
  return null;
}

/** 带当前分支判断：`git push -f` 没写目标分支时，要看现在在哪个分支上。 */
export async function dangerousCommandIn(repo: string, command: string): Promise<string | null> {
  let branch: string | null = null;
  if (/\bpush\b/.test(command)) {
    const result = await git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => null);
    if (result !== null && result.code === 0) branch = result.stdout.trim();
  }
  return dangerousCommand(command, branch);
}
