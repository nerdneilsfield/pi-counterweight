import { expect, it } from "vitest";
import { dangerousCommand } from "../../src/core/danger.ts";

const DENY = [
  "rm -rf /",
  "rm -rf /*",
  "rm -rf ~",
  "rm -rf ~/",
  "rm -rf ~/*",
  "rm -rf $HOME",
  "rm -rf \"$HOME\"",
  "rm -rf ${HOME}",
  "rm -fr /",
  "rm -Rf ~",
  "rm -r -f /",
  "rm --recursive --force /",
  "sudo rm -rf /",
  "/bin/rm -rf /",
  "ls && rm -rf /",
  "echo x; rm -rf ~",
  "cat a | rm -rf /",
  "FOO=1 rm -rf /",
  "rm -rf -- /",
  "rm -rf \"/\"",
  "ls\nrm -rf /",
  "sudo -u root rm -rf /",
  "git push --force origin main",
  "git push -f origin master",
  "git push origin +main",
  "git push --force origin HEAD:main",
  "git push -fu origin main",
  "git -C /x push --force origin main",
  "git push origin main --force",
  "git push --force origin refs/heads/master",
  "mkfs /dev/null-cw-probe",
  "mkfs.ext4 /dev/sda1",
  "sudo mkfs -t ext4 /dev/sdb",
  "dd if=/dev/zero of=/dev/sda",
];

const ALLOW = [
  "rm -rf /tmp/x",
  "rm -rf ./build",
  "rm -rf ~/proj/build",
  "rm -r /",
  "rm -f /",
  "rm file",
  "rm -rf node_modules",
  "rm -rf /tmpx",
  "git push origin main",
  "git push --force-with-lease origin main",
  "git push --force-with-lease=main:abc origin main",
  "git push --force origin feature",
  "git push -f origin dev",
  "git push --force",
  "git commit -m \"rm -rf /\"",
  "git commit -m 'git push --force origin main'",
  "echo \"git push --force origin main\"",
  "echo 'mkfs /dev/sda'",
  "grep -r \"dd of=/dev/sda\" .",
  "dd if=/dev/zero of=./file",
  "dd if=x of=/dev/null",
  "git status",
  "ls",
  "echo rm -rf /",
  "git log --format=%s main",
  "git commit -m fix && git push origin main",
  "echo \"a; rm -rf /\"",
  "echo done # rm -rf /",
  "ls | grep rm",
  "mkdir mkfs-notes",
];

it.each(DENY)("denies %j", (command) => {
  expect(dangerousCommand(command)).toMatch(/^\[counterweight\] 拒绝高危命令：/);
});

it.each(ALLOW)("allows %j", (command) => {
  expect(dangerousCommand(command)).toBeNull();
});

it("names what it refused", () => {
  expect(dangerousCommand("rm -rf $HOME")).toContain("递归强制删除 $HOME");
  expect(dangerousCommand("git push -f origin HEAD:master")).toContain("强制推送 master");
  expect(dangerousCommand("dd if=a of=/dev/sdb")).toContain("/dev/sdb");
});
