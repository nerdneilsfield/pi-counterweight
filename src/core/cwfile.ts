/**
 * 写 `.cw/` 下的文件：拒绝被换成符号链接的 `.cw`，先写临时文件再改名，读者不会看到写了一半的内容。
 *
 * Write a file under `.cw/`: refuse a symlinked `.cw`, write a temp file and
 * rename it, so a reader never sees a half-written file.
 */
import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeCwFile(repo: string, name: string, content: string): Promise<string> {
  const dir = path.join(repo, ".cw");
  await mkdir(dir, { recursive: true });
  const stat = await lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(".cw 不是目录（或被换成符号链接），拒绝写入");
  }
  const target = path.join(dir, name);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, content);
  await rename(temp, target);
  return target;
}
