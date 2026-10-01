#!/bin/sh
set -u
mode="${1:-pass}"
out="$CW_RESULT_DIR/result.json"
case "$mode" in
  hang)
    node -e 'process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});setInterval(()=>{},1000)' &
    echo $! > "$CW_RESULT_DIR/child.pid"
    wait
    ;;
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
  dirmkdir) mkdir "$out" ;;
  passmark)
    printf "%s\n" "$2" > "$out"
    : > "$CW_RESULT_DIR/marker"
    ;;
  loopinput)
    rm tests/a.py
    ln -s a.py tests/a.py
    printf "%s\n" "$2" > "$out"
    ;;
  reportrun)
    printf "%s\n" "$2" | sed -e "s|@RUN@|$CW_RUN_ID|g" -e "s|@PWD@|$PWD|g" > "$out"
    ;;
  *) printf "%s\n" "$2" > "$out"; exit "${3:-0}" ;;
esac
