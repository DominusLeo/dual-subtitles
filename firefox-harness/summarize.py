# Коротке зведення report.json прогонів стенду: python summarize.py out/<a> out/<b> ...
import json
import sys

for d in sys.argv[1:]:
    try:
        r = json.load(open(f'{d}/report.json', encoding='utf-8'))
    except OSError as e:
        print(f'== {d}: НЕМАЄ ЗВІТУ ({e})')
        continue
    print(f'== {d}')
    for f in r['state']:
        if f.get('error'):
            print('  ERR', f['frame'], f['error'])
            continue
        boxes = f.get('boxes') or []
        if not (f.get('videos') or boxes):
            continue
        print(f"  frame {f['frame'][:50]} flag={f.get('flag')} boxes={len(boxes)}")
        for v in f.get('videos') or []:
            print('    tracks', [' '.join(t.split('|')[:3]) for t in v['tracks'] if 'hidden' in t])
        for b in boxes:
            print('    box', b['display'], repr(b['top'])[:60], '/', repr(b['bottom'])[:60])
    for l in r['dualSubsLogs']:
        print('   ', l[:140])
