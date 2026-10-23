/**
 * `/cw-setup`：用 pi 的对话框问用户，写 `.cw/project.toml`。模型从 pi 当前可用的模型里选。
 * 写之前先过 `parseProjectConfig`，不合法的配置不落盘。重写会丢掉原文件里的注释。
 *
 * `/cw-setup`: ask the user through pi's dialogs and write `.cw/project.toml`.
 * Models are picked from what pi can use now. The text goes through
 * `parseProjectConfig` before it is written. A rewrite drops comments in the old file.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stringify } from "smol-toml";
import { writeCwFile } from "../../core/cwfile.js";
import { loadProjectConfig, parseProjectConfig, type ProjectConfig, type RoleModels } from "../../core/config.js";

const ROLE_QUESTIONS: Array<[keyof RoleModels, string]> = [
  ["explorer", "explorer（找代码）用哪个模型"],
  ["review", "review（查做错）用哪个模型"],
  ["over_review", "over_review（查多做）用哪个模型"],
  ["research", "research（深入研究）用哪个模型"],
  ["historian", "historian（赛博史官，写 .cw/HISTORY.md）用哪个模型"],
];

const SKIP = "（不配置）";
const KEEP = "（保持现状）";

/** @returns 是否写入了文件 / whether the file was written */
export async function runSetup(ctx: ExtensionCommandContext, repo: string): Promise<boolean> {
  let existing: ProjectConfig | null = null;
  try {
    existing = await loadProjectConfig(repo);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "未知错误";
    if (!await ctx.ui.confirm("现有配置无法读取", `${reason}\n\n丢弃它，从头设置？`)) return false;
  }

  const available = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
  const models: Record<string, string> = {};
  for (const [role, question] of ROLE_QUESTIONS) {
    const current = existing?.models[role] ?? null;
    const options = [current === null ? SKIP : KEEP, ...(current === null ? [] : [SKIP]), ...available];
    const picked = await ctx.ui.select(`${question}${current === null ? "" : `（现为 ${current}）`}`, options);
    if (picked === undefined) return false;
    if (picked === KEEP) models[role] = current!;
    else if (picked !== SKIP) models[role] = picked;
  }

  // 标题里带说明：TUI 的 input 不显示 placeholder；RPC 客户端可能不允许提交空值，所以 = 也表示保持。
  // Hints live in the title: the TUI input ignores the placeholder, and an RPC client may refuse an empty submit, so = also means keep.
  const checkLine = await ctx.ui.input(
    `结束检查命令（每轮结束跑一次，退出码非 0 算失败）\n${existing?.check ? `现为 ${existing.check.cmd.join(" ")}；= 保持，- 清除` : "例如 npm test；- 表示不设"}`,
    "npm test",
  );
  if (checkLine === undefined) return false;
  const pathsLine = await ctx.ui.input(
    `受保护路径（逗号分隔，agent 不能直接改）\n${existing && existing.protect.paths.length > 0 ? `现为 ${existing.protect.paths.join(", ")}；= 保持，- 清除` : "例如 tests/, package.json；- 表示不设"}`,
    "tests/, package.json",
  );
  if (pathsLine === undefined) return false;

  const doc: Record<string, unknown> = { version: 1 };
  const check = checkLine.trim();
  if (check === "" || check === "=") {
    if (existing?.check) doc.check = existing.check;
  } else if (check !== "-") {
    // shortcut: 按空白切 argv，不识别引号，需要引号的命令请手写 project.toml。
    doc.check = { ...existing?.check, cmd: check.split(/\s+/) };
  }
  const paths = pathsLine.trim();
  if (paths === "" || paths === "=") {
    if (existing && existing.protect.paths.length > 0) doc.protect = { paths: existing.protect.paths };
  } else if (paths !== "-") {
    doc.protect = { paths: paths.split(",").map((item) => item.trim()).filter((item) => item !== "") };
  }
  if (Object.keys(models).length > 0) doc.models = models;

  const text = stringify(doc);
  try {
    parseProjectConfig(text);
  } catch (error) {
    ctx.ui.notify(`Counterweight: 配置不合法，未写入（${error instanceof Error ? error.message : "未知错误"}）`, "error");
    return false;
  }
  if (!await ctx.ui.confirm("写入 .cw/project.toml？", text)) return false;
  try {
    await writeCwFile(repo, "project.toml", text);
  } catch (error) {
    ctx.ui.notify(`Counterweight: 写入失败（${error instanceof Error ? error.message : "未知错误"}）`, "error");
    return false;
  }
  ctx.ui.notify("Counterweight: 已写入 .cw/project.toml，立即生效", "info");
  return true;
}
