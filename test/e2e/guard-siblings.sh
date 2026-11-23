#!/usr/bin/env bash
# Two sibling guards on one credentials file in a fresh open room, the way the two welcome bots run, then a scored check.
#   CRED=<file> MEETJS=<gifos test/swarm/meet.js> test/e2e/guard-siblings.sh <out dir> [seconds=480] [mode: none|r0|r1|move]
# rank 0 starts at once, rank 1 60 s later (the live order). r0/r1 restarts that sibling at 200 s. move: at 100 s a third
# copy of the credentials joins ANOTHER room for 50 s, so a one-meeting pass moves away from both siblings, who must
# take it back.
# An observer seat (meet.js, DEBUG) joins at 330 s, stays 60 s and must get the greeting.
# Scored by guard-siblings-score.js (one lead from 300 s with its ticket and the capture, the greeting, only the guarded
# room joined with the plan, no ticket moved).
set -u
out=$1; secs=${2:-480}; restart=${3:-none}
mkdir -p "$out"
here=$(cd "$(dirname "$0")" && pwd)
room=sib$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')
r0=""; r1=""
[ "$restart" = r0 ] && r0=200
[ "$restart" = r1 ] && r1=200
echo "room $room restart $restart" > "$out/run.txt"
RESTART_AT=$r0 ROOM=$room RANK=0 NAME="Sib Bot 1" node "$here/guard-siblings.js" "$secs" > "$out/r0.log" 2>&1 &
p0=$!
sleep 60
RESTART_AT=$( [ -n "$r1" ] && echo $((r1 - 60)) ) ROOM=$room RANK=1 NAME="Sib Bot 2" node "$here/guard-siblings.js" $((secs - 60)) > "$out/r1.log" 2>&1 &
p1=$!
if [ "$restart" = move ]; then
  sleep 40
  ROOM=${room}x RANK=0 NAME="Elsewhere Bot" node "$here/guard-siblings.js" 50 > "$out/move.log" 2>&1
  sleep 180
else
  sleep 270
fi
( cd "$(dirname "$MEETJS")/../.." && timeout 150 node test/swarm/meet.js --room "$room" --name "Observer" --script "sleep 45; people; chat; shot $out/observer.png" > "$out/observer.log" 2>&1 )
wait $p0 $p1
node "$here/guard-siblings-score.js" "$out" | tee "$out/verdict.txt"
