#!/usr/bin/env bash
# Повна регресія: Firefox (preload), Firefox (Adblock Plus + Violentmonkey), Chrome (preload). Послідовно.
cd "$(dirname "$0")"
KINO="https://kinogoua.net/action/12041-sokolinyy-glaz-2021-hd-arrow13-v542.html"
REZKA="https://rezka-tv.org/cartoons/fantasy/40418-chto-esli-2021-latest/238-subtitles.html"
EMBED="https://api.ortified.ws/embed/movie/52008"
run() { echo "$(date +%T) start $*" >&2; timeout 280 node run.mjs "$2" "$3" "out/$1" > /dev/null 2> "out/$1.steps.log"; echo "$(date +%T) done $1 rc=$?" >&2; }
run reg-ff-kino "$KINO" steps-kinogoua.json
run reg-ff-rezka "$REZKA" steps-rezka.json
EXT=1 run reg-ffext-rezka "$REZKA" steps-rezka.json
BROWSER=chrome run reg-cr-embed "$EMBED" steps-embed.json
BROWSER=chrome run reg-cr-rezka "$REZKA" steps-rezka.json
BROWSER=chrome run reg-cr-kino "$KINO" steps-kinogoua.json
python summarize.py out/reg-ff-kino out/reg-ff-rezka out/reg-ffext-rezka out/reg-cr-embed out/reg-cr-rezka out/reg-cr-kino
