"""
Regenerates sectors.js from sectors.py.

Run this after any edit to sectors.py:
    python3 build_sectors.py

Then redeploy sectors.js along with the other files — the browser loads
sectors.js, never sectors.py. This script has no dependencies beyond the
standard library.
"""

import json
import sectors


def js_str(s):
    # json.dumps gives a double-quoted, safely-escaped string literal.
    # That's also valid JS string syntax, so it's reused as-is.
    return json.dumps(s)


def build():
    lines = []
    lines.append('var SECTORS = [')
    total = len(sectors.SECTORS)
    for i, s in enumerate(sectors.SECTORS):
        comma = ',' if i < total - 1 else ''
        lines.append('    { id:%s, label:%s, base:%d, defaultOn:%s,' % (
            js_str(s['id']), js_str(s['label']), s['base'],
            'true' if s['defaultOn'] else 'false'))
        lines.append('      why:%s }%s' % (js_str(s['why']), comma))
    lines.append('];')
    lines.append('')
    lines.append("// [osmKey, osmValue, sectorId, brandRequired?] -- brandRequired filters out one-off")
    lines.append("// independent shops for categories where they'd otherwise flood the results.")
    lines.append('var TAGMAP = [')
    total = len(sectors.TAGMAP)
    for i, t in enumerate(sectors.TAGMAP):
        key, val, sector_id, brand_req = t
        comma = ',' if i < total - 1 else ''
        lines.append('    [%s,%s,%s,%s]%s' % (
            js_str(key), js_str(val), js_str(sector_id),
            'true' if brand_req else 'false', comma))
    lines.append('];')
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    output = build()
    with open('sectors.js', 'w', encoding='utf-8') as f:
        f.write(output)
    print('Wrote sectors.js: %d sectors, %d tag rows' % (len(sectors.SECTORS), len(sectors.TAGMAP)))
