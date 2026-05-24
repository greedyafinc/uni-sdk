import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { OpenUrl } from "./browser-auth";

export const defaultOpenUrl: OpenUrl = (url: string): void => {
  const p = platform();
  const cmd = p === "darwin" ? "open" : p === "win32" ? "cmd" : "xdg-open";
  const args = p === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
};
