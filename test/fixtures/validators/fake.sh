#!/bin/sh
# 伪验证器：按 $1 选模式，产出——或故意不产出——验证器证据，供 validators 测试覆盖边界
# 与失败路径。约定：证据是 "$CW_RESULT_DIR/result.json" 中的协议 1 JSON，run_id 取
# $CW_RUN_ID；$2 是 payload（reportfile 模式下为 payload 文件路径），$3 是默认分支的退出码。
#
# 模式（$1）：hang 永不结束、late 只在收到 TERM 时写结果、touch 写工作区文件、
# dirmkdir 把结果路径建成目录、passmark 写结果并留 marker、loopinput 制造自引用符号链接、
# reportrun/reportfile 替换 @RUN@→$CW_RUN_ID（reportrun 还有 @PWD@→$PWD）、none 不写结果；
# 其余模式（含缺省 "pass"）原样写出 payload 并以 $3 退出。
#
# Fake validator for the validators tests: $1 selects a mode that produces — or
# deliberately withholds — validator evidence. Evidence is protocol-1 JSON in
# "$CW_RESULT_DIR/result.json" with run_id taken from $CW_RUN_ID; $2 is the payload
# (a payload file path in the reportfile mode) and $3 the exit code of the default
# branch.
#
# Modes ($1): hang never finishes, late writes a result only once TERM arrives,
# touch writes into the workspace, dirmkdir turns the result path into a directory,
# passmark writes the payload plus a marker, loopinput builds a self-referential
# symlink, reportrun/reportfile substitute @RUN@ → $CW_RUN_ID (reportrun also
# @PWD@ → $PWD), and none writes nothing; any other mode — including the default
# "pass" — writes the payload verbatim and exits with $3.
set -u
mode="${1:-pass}"
out="$CW_RESULT_DIR/result.json"
case "$mode" in
  # 起一个忽略 SIGTERM/SIGINT 的子进程并 wait：永不结束，pid 记入 $CW_RESULT_DIR/child.pid。
  # Spawns a signal-ignoring child and waits: it never ends; the pid lands in child.pid.
  hang)
    node -e 'process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});setInterval(()=>{},1000)' &
    echo $! > "$CW_RESULT_DIR/child.pid"
    wait
    ;;
  # 只在收到 TERM 的那一刻才写出合法结果并 exit 0：检验“进程已被杀”之后到达的证据。
  # Writes a valid result and exits 0 only when TERM arrives: late evidence after a kill.
  late)
    trap 'printf "%s\n" "{\"protocol\":1,\"run_id\":\"$CW_RUN_ID\",\"complete\":true,\"checks\":[{\"id\":\"keep\",\"status\":\"pass\"}],\"build\":{\"required\":false},\"summary\":\"late\",\"logs\":[]}" > "$out"; exit 0' TERM
    sleep 30 &
    wait
    ;;
  touch)
    printf x >> tracked.txt
    printf "%s\n" "{\"protocol\":1,\"run_id\":\"$CW_RUN_ID\",\"complete\":true,\"checks\":[{\"id\":\"keep\",\"status\":\"pass\"}],\"build\":{\"required\":false},\"summary\":\"touched\",\"logs\":[]}" > "$out"
    ;;
  none) exit 0 ;;
  # 把 result.json 建成目录：读证据时拿到目录而非判决（结果畸形）。
  # Makes the result path a directory, so reading the evidence fails or yields garbage.
  dirmkdir) mkdir "$out" ;;
  passmark)
    printf "%s\n" "$2" > "$out"
    : > "$CW_RESULT_DIR/marker"
    ;;
  # 把 tests/a.py 换成指向自身的符号链接，再用 payload 报告结果。
  # Replaces tests/a.py with a symlink to itself: a self-referential input path.
  loopinput)
    rm tests/a.py
    ln -s a.py tests/a.py
    printf "%s\n" "$2" > "$out"
    ;;
  reportrun)
    printf "%s\n" "$2" | sed -e "s|@RUN@|$CW_RUN_ID|g" -e "s|@PWD@|$PWD|g" > "$out"
    ;;
  reportfile)
    # payload 从 $2 指定的文件读取，测试可在两次验证之间改变结论而无需改动已批准的命令；
    # @RUN@ 与 reportrun 一样按 run 替换。
    # Payload read from the file given as $2, so a test can change the
    # verdict between validation runs without touching the approved command.
    # @RUN@ is substituted per run, like reportrun.
    printf "%s\n" "$(cat "$2")" | sed -e "s|@RUN@|$CW_RUN_ID|g" > "$out"
    ;;
  *) printf "%s\n" "$2" > "$out"; exit "${3:-0}" ;;
esac
