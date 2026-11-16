/**
 * `.cw/repos.txt`：主仓库里列出的额外仓库（兄弟目录里的其他 git 仓库），每行一个路径，相对主仓库根或绝对路径，
 * `#` 开头和空行忽略。保护、范围、回合基线和结束检查因此覆盖这些仓库。不存在的路径、不是目录或没有 `.git` 的目录、
 * 主仓库自己、嵌套在主仓库内的目录都被丢弃，重复项只留一个。没有文件或没有有效行时结果为空，行为与没有这个功能时完全一致。
 * 这个文件本身由各宿主的保护逻辑始终保护：它扩大模型的写入范围。两个仓库里这个文件逐字节相同，不引用任何宿主。
 *
 * `.cw/repos.txt`: extra git repositories (siblings of the main repo) the main repo opts into, one path per line,
 * relative to the main repo root or absolute; `#` lines and blanks are ignored. Missing paths, non-directories,
 * directories without `.git`, the main repo itself, and directories nested inside it are dropped; duplicates are
 * collapsed. With no file or no valid line the result is empty and behaviour is exactly as without this feature.
 * Byte-identical in both repositories.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const REPOS_FILE = ".cw/repos.txt";

const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** 额外仓库的真实绝对路径，按文件顺序。没有文件、读失败或没有有效条目时为空数组。 */
export async function readRepos(root: string): Promise<string[]> {
  let text: string;
  let main: string;
  try {
    text = await readFile(path.join(root, REPOS_FILE), "utf8");
    main = await realpath(root);
  } catch {
    return [];
  }
  const repos: string[] = [];
  for (const line of text.split("\n").map((item) => item.trim())) {
    if (line === "" || line.startsWith("#")) continue;
    try {
      const real = await realpath(path.resolve(root, line));
      if (!(await stat(real)).isDirectory()) continue;
      await stat(path.join(real, ".git"));
      if (inside(main, real) || repos.includes(real)) continue;
      repos.push(real);
    } catch {
      // Missing or unreadable entry: dropped.
    }
  }
  return repos;
}

/** 先 realpath 目标；目标不存在时 realpath 最深的已有祖先再拼回剩余段。路径上没有任何现存节点时抛错。 */
async function realTarget(absolute: string): Promise<string> {
  const rest: string[] = [];
  let current = path.resolve(absolute);
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch (error) {
      const parent = path.dirname(current);
      if (parent === current || !(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * 绝对路径属于主仓库还是某个额外仓库：返回该仓库根和 `/` 分隔的相对路径（仓库根本身为空串）；
 * 都不属于、或无法解析时为 null。主仓库优先。`extras` 是 `readRepos` 的结果。
 */
export async function ownerOf(
  root: string, extras: readonly string[], absolute: string,
): Promise<{ repo: string; relative: string } | null> {
  let target: string;
  let main: string;
  try {
    target = await realTarget(absolute);
    main = await realpath(root);
  } catch {
    return null;
  }
  for (const repo of [main, ...extras]) {
    if (!inside(repo, target)) continue;
    return { repo, relative: path.relative(repo, target).split(path.sep).join("/") };
  }
  return null;
}
