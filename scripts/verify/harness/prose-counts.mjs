import { readFileSync } from 'node:fs';

/**
 * Paragraphs of adjacent whole-line comments, not lines.
 *
 * Every stale count this was built from wrapped across a line break, so a line-scoped grep sees
 * the sameness idiom on one line and the number it governs on the next and matches neither half.
 * Consecutive comment lines are joined into one string and matched as a paragraph; a blank
 * comment line or a line of code ends the paragraph, which is where a claim ends too.
 *
 * Whole-line comments only. Both comment syntaxes are read, since this gate is shell driving
 * TypeScript harnesses and the species has appeared in both. It used to be one shell script whose
 * payload was a stack of TypeScript heredocs, which is why one reader has always had to handle
 * both.
 */
const payload = (line) => {
  if (/^\s*#!/.test(line)) return null;
  let m;
  if ((m = /^\s*\/\/\s?(.*)$/.exec(line))) return m[1];
  if ((m = /^\s*#\s?(.*)$/.exec(line))) return m[1];
  if ((m = /^\s*\/\*\*?\s?(.*)$/.exec(line))) return m[1].replace(/\s*\*\/\s*$/, '');
  if (/^\s*\*\/\s*$/.test(line)) return '';
  if ((m = /^\s*\*\s?(.*)$/.exec(line))) return m[1].replace(/\s*\*\/\s*$/, '');
  return null;
};

const CARD =
  '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|' +
  'fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|' +
  'ninety)';
const LEDGERS =
  'ALLOWED|CROSS_ALLOWED|PRESENCE|PRESENCE_ALLOWED|PRESENCE_BARREN|DEFECTS|THREW|UNNAMED|' +
  'KNOWN_UNNAMED|SELECT_OPTIONAL|POOL';

/**
 * The closed set, each entry a shape one of the removed sentences was written in.
 *
 * Widening any of these is how the check turns into the broad formulation that was measured and
 * rejected above. Narrowing one to quieten a hit is worse: the hit is the finding.
 */
const IDIOMS = [
  ['a span', new RegExp(`\\b${CARD} to ${CARD}\\b`, 'i')],
  ['a ratio', new RegExp(`\\b${CARD} of ${CARD}\\b`, 'i')],
  ['an unchanged quantity', new RegExp(`\\bat the same (?:count|${CARD})\\b`, 'i')],
  ['a rejection count', new RegExp(`\\bfrom ${CARD} rejections\\b`, 'i')],
  ['a level', new RegExp(`\\bare at ${CARD}\\b`, 'i')],
  ['a per-mode count', new RegExp(`\\b${CARD} in all three modes\\b`, 'i')],
  ['a ledger size', new RegExp(`\\b${CARD} (?:${LEDGERS}) entr(?:y|ies)\\b`)],
];

// Every file the gate is written in, not one. It was one when this was written, and the paragraph
// is the unit either way: a comment block cannot span two files, and it could not span a heredoc
// boundary in the file this was split out of either, so the same blocks are read as before.
// Reported together rather than file by file, because a per-file verdict over fifty files buries
// the handful of hits under fifty lines saying nothing was found.
const files = process.argv.slice(2);
const blocks = [];
for (const file of files) {
  const rel = file.replace(/^.*\/(scripts\/.*)$/, '$1');
  const lines = readFileSync(file, 'utf8').split('\n');
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const p = payload(lines[i]);
    if (p === null || p.trim() === '') {
      cur = null;
      continue;
    }
    if (!cur) blocks.push((cur = { rel, start: i + 1, end: i + 1, text: p.trim() }));
    else {
      cur.end = i + 1;
      cur.text += ` ${p.trim()}`;
    }
  }
}

const hits = [];
for (const b of blocks) {
  const matched = IDIOMS.map(([name, re]) => [name, re.exec(b.text)]).filter(([, m]) => m);
  if (matched.length) hits.push({ b, matched });
}

if (!hits.length) {
  // Not a pass. The check cannot tell a clean file from a pattern that has stopped matching, and
  // this line says which claim is being made.
  console.log(
    `    no comment block in the ${files.length} file(s) this gate is written in matches the ` +
      'idioms a restated count is written in'
  );
} else {
  console.log(
    `    WARN: ${hits.length} comment block(s) of ${blocks.length}, across the ${files.length} ` +
      'file(s) this gate is written in, state a quantity in ' +
      'the idiom a restated one is written in. Not a gate, and not all of them are wrong: read'
  );
  console.log(
    '          each one and check it against the declaration or printed line that holds the same'
  );
  console.log('          quantity, then delete the number or leave a verdict in the task report.');
  for (const { b, matched } of hits) {
    console.log(`      ${b.rel}:${b.start}-${b.end}  [${matched.map(([n]) => n).join(', ')}]`);
    // The whole block, not a window around the match. Two blocks were cleared as false positives
    // by reading a 55-character excerpt while a stale count sat elsewhere in the same comment:
    // "The other ten are new" three words outside one window, and a byte figure the run had
    // moved on from outside the other. The idiom is what finds a block; it is not what makes the
    // block wrong, so an excerpt is the wrong unit to adjudicate on.
    for (const line of b.text.match(/.{1,96}(?:\s|$)/g) ?? [b.text]) {
      console.log(`          ${line.trimEnd()}`);
    }
  }
}
