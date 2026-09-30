import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function counterweight(pi: ExtensionAPI): void {
  pi.registerCommand("cw-version", {
    description: "显示 Counterweight 当前加载的 Pi 版本",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Counterweight: pi ${VERSION}`, "info");
    },
  });
}
