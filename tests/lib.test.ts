import { describe, expect, it } from 'vitest';
import { parseAnsi, stripAnsi } from '../src/lib/ansi';
import {
  baseName,
  clamp,
  dayBucket,
  dirName,
  formatBytes,
  formatCost,
  formatDuration,
  formatTokens,
  langFromPath,
  plural,
  relPath,
  resetIn,
  shortcutKeys,
  isMac,
  timeAgo,
} from '../src/lib/format';
import { fuzzy, highlightRuns, wordPrefix } from '../src/lib/fuzzy';
import { lexBlocks, PENDING_HREF, repairTail } from '../src/lib/md';
import { wordDiff } from '../src/lib/word-diff';

// ───────────────────────────────── fuzzy ─────────────────────────────────

const rank = (q: string, list: string[]) =>
  list
    .map((t) => ({ t, m: fuzzy(q, t) }))
    .filter((x) => x.m)
    .sort((a, b) => b.m!.score - a.m!.score)
    .map((x) => x.t);

describe('fuzzy', () => {
  it('an empty query matches everything with no highlights', () => {
    expect(fuzzy('', 'Anything')).toEqual({ score: 0, indices: [] });
    expect(fuzzy('   ', 'Anything')).toEqual({ score: 0, indices: [] });
  });

  it('is case-insensitive and highlights a contiguous substring', () => {
    expect(fuzzy('SESS', 'New session')?.indices).toEqual([4, 5, 6, 7]);
  });

  it('returns null when any token is missing', () => {
    expect(fuzzy('new zebra', 'New session')).toBeNull();
    expect(fuzzy('xyz', 'New session')).toBeNull();
  });

  it('ranks word starts and prefixes above scattered matches', () => {
    expect(rank('nsess', ['Unread sessions', 'New session'])[0]).toBe('New session');
    expect(rank('set', ['Reset layout', 'Settings'])[0]).toBe('Settings');
  });

  it('prefers shorter texts on ties', () => {
    expect(rank('settings', ['Settings for the whole workspace', 'Settings'])[0]).toBe('Settings');
  });

  it('matches every space-separated token and merges their highlights', () => {
    const m = fuzzy('open term', 'Open the terminal');
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([0, 1, 2, 3, 9, 10, 11, 12]);
  });

  it('matches camelCase and path boundaries as word starts', () => {
    expect(fuzzy('sv', 'SessionView.tsx')?.indices).toEqual([0, 7]);
    expect(fuzzy('srt', 'src/core/runtime.ts')).not.toBeNull();
  });

  it('rejects long scattered subsequences', () => {
    expect(fuzzy('aeiou', 'a big red fox jumped over us')).toBeNull();
  });

  it('wordPrefix requires each token to start a word', () => {
    expect(wordPrefix('perm', 'Edit permissions')).not.toBeNull();
    expect(wordPrefix('miss', 'Edit permissions')).toBeNull();
    expect(wordPrefix('', 'x')).toBe(0);
    expect(wordPrefix('ed per', 'Edit permissions')!).toBeGreaterThan(wordPrefix('per', 'Edit permissions')!);
  });

  it('highlightRuns splits text into hit and miss runs', () => {
    expect(highlightRuns('hello', [])).toEqual([{ text: 'hello', hit: false }]);
    expect(highlightRuns('hello', [0, 1, 4])).toEqual([
      { text: 'he', hit: true },
      { text: 'll', hit: false },
      { text: 'o', hit: true },
    ]);
  });
});

// ───────────────────────────────── markdown ─────────────────────────────────

describe('md.lexBlocks', () => {
  it('splits top-level blocks whose raw lengths add up to the text', () => {
    const text = '# Title\n\nA paragraph.\n\n```ts\nconst a = 1;\n```\n\n- one\n- two\n';
    const { blocks } = lexBlocks(null, text);
    expect(blocks.map((b) => b.raw).join('')).toBe(text);
    expect(blocks.filter((b) => b.token.type !== 'space').map((b) => b.token.type)).toEqual(['heading', 'paragraph', 'code', 'list']);
  });

  it('reuses settled blocks while text streams in', () => {
    const a = lexBlocks(null, '# Title\n\nFirst paragraph.\n\nSecond');
    const b = lexBlocks(a, '# Title\n\nFirst paragraph.\n\nSecond paragraph grows');
    expect(b.blocks[0]).toBe(a.blocks[0]);
    expect(b.blocks.map((x) => x.raw).join('')).toBe(b.text);
    expect(b.blocks.at(-1)!.raw).toContain('Second paragraph grows');
  });

  it('re-lexes from scratch when the text is not an extension', () => {
    const a = lexBlocks(null, '# Title\n\nOne.\n\nTwo');
    const b = lexBlocks(a, '# Other\n\nOne.\n\nTwo');
    expect(b.blocks[0]).not.toBe(a.blocks[0]);
    expect((b.blocks[0].token as { text: string }).text).toBe('Other');
  });

  it('never reuses blocks across an open code fence', () => {
    const a = lexBlocks(null, 'Intro.\n\n```js\nlet x = 1;\n\nlet y');
    const b = lexBlocks(a, 'Intro.\n\n```js\nlet x = 1;\n\nlet y = 2;\n```\n\nAfter.');
    expect(b.blocks.map((x) => x.raw).join('')).toBe(b.text);
    const code = b.blocks.find((x) => x.token.type === 'code')!;
    expect((code.token as { text: string }).text).toBe('let x = 1;\n\nlet y = 2;');
  });

  it('lexes fully when link reference definitions are present', () => {
    const text = 'See [docs][d].\n\nMore.\n\n[d]: https://example.com\n';
    const a = lexBlocks(null, text.slice(0, 20));
    const b = lexBlocks(a, text);
    expect(b.blocks.map((x) => x.raw).join('')).toBe(text);
  });

  it('keeps single newlines as line breaks in paragraphs and list items, not in code or tables', () => {
    const inlineTypes = (t: { tokens?: { type: string }[] }) => (t.tokens ?? []).map((x) => x.type);
    const [p] = lexBlocks(null, 'Apple\nBanana\nOrange').blocks;
    expect(inlineTypes(p.token as never)).toEqual(['text', 'br', 'text', 'br', 'text']);

    const [list] = lexBlocks(null, '- one\n  two\n- three').blocks;
    const first = (list.token as unknown as { items: { tokens: { tokens?: { type: string }[] }[] }[] }).items[0].tokens[0];
    expect(inlineTypes(first)).toContain('br');

    const [code] = lexBlocks(null, '```\na\nb\n```').blocks;
    expect((code.token as { text: string }).text).toBe('a\nb');
    const [table] = lexBlocks(null, '| a | b |\n| - | - |\n| 1 | 2 |').blocks;
    expect(table.token.type).toBe('table');
  });
});

describe('md.repairTail', () => {
  it('leaves finished text alone', () => {
    expect(repairTail('')).toBe('');
    expect(repairTail('Plain **bold** and `code`.')).toBe('Plain **bold** and `code`.');
  });

  it('closes dangling emphasis on the last line', () => {
    expect(repairTail('This is **important')).toBe('This is **important**');
    expect(repairTail('An *aside')).toBe('An *aside*');
    expect(repairTail('Gone ~~soon')).toBe('Gone ~~soon~~');
    expect(repairTail('Both ***at once')).toBe('Both ***at once***');
  });

  it('hides an opener with nothing after it yet', () => {
    expect(repairTail('Start of **')).toBe('Start of ');
    expect(repairTail('Text `')).toBe('Text ');
  });

  it('closes an open code span', () => {
    expect(repairTail('Run `pnpm te')).toBe('Run `pnpm te`');
  });

  it('does not treat bullets, rules or snake_case as emphasis', () => {
    expect(repairTail('* item')).toBe('* item');
    expect(repairTail('some_snake_case')).toBe('some_snake_case');
    expect(repairTail('Text\n\n***')).toBe('Text\n\n***');
  });

  it('renders half-arrived links with a pending href', () => {
    expect(repairTail('See [the docs](https://exa')).toBe(`See [the docs](${PENDING_HREF})`);
    expect(repairTail('See [the docs')).toBe(`See [the docs](${PENDING_HREF})`);
    expect(repairTail('A task [x')).toBe('A task [x');
  });

  it('holds back an image until it is whole', () => {
    expect(repairTail('Look: ![diagram](img/a.p')).toBe('Look: ');
  });

  it('keeps unclosed fences open but drops a half-arrived closing fence', () => {
    expect(repairTail('```ts\nconst a = 1;')).toBe('```ts\nconst a = 1;');
    expect(repairTail('```ts\nconst a = 1;\n``')).toBe('```ts\nconst a = 1;\n');
    // Emphasis-looking text inside a fence is code, not markdown.
    expect(repairTail('```\nlet **x')).toBe('```\nlet **x');
  });

  it('drops the first backticks of an opening fence', () => {
    expect(repairTail('Here:\n\n``')).toBe('Here:\n\n');
  });

  it('waits for a table header and delimiter row before showing it', () => {
    expect(repairTail('Intro\n\n| a | b |')).toBe('Intro\n\n');
    expect(repairTail('Intro\n\n| a | b |\n| --')).toBe('Intro\n\n');
    expect(repairTail('Intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('Intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
    // A lone pipe would open an empty row.
    expect(repairTail('| a | b |\n| --- | --- |\n| 1 | 2 |\n|')).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('only touches the last block', () => {
    expect(repairTail('Earlier **open\n\nNow *this')).toBe('Earlier **open\n\nNow *this*');
  });
});

// ───────────────────────────────── format ─────────────────────────────────

describe('format', () => {
  it('baseName and dirName handle both separators and trailing slashes', () => {
    expect(baseName('C:\\work\\ade\\src\\main.tsx')).toBe('main.tsx');
    expect(baseName('/home/me/project/')).toBe('project');
    expect(baseName('')).toBe('');
    expect(baseName(null)).toBe('');
    expect(dirName('/home/me/file.ts')).toBe('/home/me');
    expect(dirName('/file.ts')).toBe('/');
    expect(dirName('C:\\a\\b.txt')).toBe('C:/a');
    expect(dirName('file.ts')).toBe('');
  });

  it('relPath prefers the root, then the home folder', () => {
    expect(relPath('/home/me/proj/src/a.ts', '/home/me/proj', '/home/me')).toBe('src/a.ts');
    expect(relPath('/home/me/proj', '/home/me/proj/')).toBe('.');
    expect(relPath('/home/me/other/b.ts', '/home/me/proj', '/home/me')).toBe('~/other/b.ts');
    expect(relPath('C:\\Users\\Me\\Proj\\x.ts', 'c:/users/me/proj')).toBe('x.ts');
    expect(relPath('/etc/hosts', '/home/me/proj', '/home/me')).toBe('/etc/hosts');
    // A sibling folder sharing a prefix is not inside the root.
    expect(relPath('/home/me/proj-2/a.ts', '/home/me/proj')).toBe('/home/me/proj-2/a.ts');
  });

  it('formats tokens, cost, bytes and durations', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(45_600)).toBe('46k');
    expect(formatTokens(1_500_000)).toBe('1.50M');
    expect(formatTokens(12_000_000)).toBe('12.0M');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.234)).toBe('$1.23');
    expect(formatCost(12.34)).toBe('$12.3');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(20 * 1024)).toBe('20 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(-5)).toBe('0ms');
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_725_000)).toBe('1h 2m');
  });

  it('timeAgo, dayBucket and resetIn', () => {
    const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
    expect(timeAgo(now - 10_000, now)).toBe('now');
    expect(timeAgo(now + 60_000, now)).toBe('now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m');
    expect(timeAgo(now - 3 * 3600_000, now)).toBe('3h');
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d');
    expect(timeAgo(now - 14 * 86_400_000, now)).toBe('2w');
    expect(dayBucket(now - 3600_000, now)).toBe('Today');
    expect(dayBucket(now - 86_400_000, now)).toBe('Yesterday');
    expect(dayBucket(now - 3 * 86_400_000, now)).toBe('This week');
    expect(dayBucket(now - 20 * 86_400_000, now)).toBe('This month');
    expect(dayBucket(now - 90 * 86_400_000, now)).toBe('Earlier');
    expect(resetIn(undefined, now)).toBe('');
    expect(resetIn(now - 1, now)).toBe('now');
    expect(resetIn(now + 30 * 60_000, now)).toBe('30m');
    expect(resetIn(now + 150 * 60_000, now)).toBe('2h 30m');
    expect(resetIn(now + 50 * 3600_000, now)).toBe('2d 2h');
  });

  it('plural, clamp, langFromPath and shortcutKeys', () => {
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(3, 'file')).toBe('3 files');
    expect(plural(2, 'child', 'children')).toBe('2 children');
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(langFromPath('src/App.TSX')).toBe('tsx');
    expect(langFromPath('Dockerfile')).toBe('docker');
    expect(langFromPath('notes')).toBe('text');
    expect(langFromPath('a.unknown')).toBe('text');
    expect(langFromPath(undefined)).toBe('text');
    // Node's navigator reports the host: Mac symbols on macOS, words elsewhere.
    expect(shortcutKeys('mod+shift+k')).toEqual(isMac ? ['⌘', '⇧', 'K'] : ['Ctrl', 'Shift', 'K']);
    expect(shortcutKeys('alt+enter')).toEqual(isMac ? ['⌥', '↵'] : ['Alt', '↵']);
    expect(shortcutKeys('esc')).toEqual(['Esc']);
  });
});

// ───────────────────────────────── ansi ─────────────────────────────────

describe('ansi', () => {
  const E = '\u001b';

  it('passes plain text through', () => {
    expect(parseAnsi('hello')).toEqual([{ text: 'hello' }]);
    expect(parseAnsi('')).toEqual([]);
    expect(stripAnsi('hello')).toBe('hello');
  });

  it('maps SGR colours and styles to classes and resets them', () => {
    expect(parseAnsi(`${E}[31mred${E}[0m plain ${E}[1;32mbold green${E}[22m green`)).toEqual([
      { text: 'red', cls: 'a-red' },
      { text: ' plain ' },
      { text: 'bold green', cls: 'a-green a-bold' },
      { text: ' green', cls: 'a-green' },
    ]);
    expect(parseAnsi(`${E}[90mgray${E}[39m`)).toEqual([{ text: 'gray', cls: 'a-gray' }]);
    expect(parseAnsi(`${E}[2;3mquiet${E}[m`)).toEqual([{ text: 'quiet', cls: 'a-dim a-italic' }]);
  });

  it('skips extended colours without misreading their parameters', () => {
    // 38;5;31 must not be read as "31 = red"; 38;2;r;g;b likewise.
    expect(parseAnsi(`${E}[38;5;31mx${E}[0m`)).toEqual([{ text: 'x' }]);
    expect(parseAnsi(`${E}[38;2;255;0;0;1my`)).toEqual([{ text: 'y', cls: 'a-bold' }]);
  });

  it('drops cursor movement and OSC sequences', () => {
    expect(stripAnsi(`${E}[2K${E}[1Gdone`)).toBe('done');
    expect(stripAnsi(`${E}]0;title${E}\\after`)).toBe('after');
    expect(stripAnsi(`${E}]8;;https://x.dev\u0007link${E}]8;;\u0007`)).toBe('link');
  });

  it('applies carriage returns like a terminal', () => {
    expect(stripAnsi('10%\r50%\r100%\nnext')).toBe('100%\nnext');
    expect(stripAnsi('a\r\nb')).toBe('a\nb');
    expect(parseAnsi('loading\rdone')).toEqual([{ text: 'done' }]);
  });
});

// ───────────────────────────────── word diff ─────────────────────────────────

describe('wordDiff', () => {
  const pick = (s: string, rs: [number, number][]) => rs.map(([a, b]) => s.slice(a, b));

  it('returns null for identical, blank or wholly rewritten lines', () => {
    expect(wordDiff('same', 'same')).toBeNull();
    expect(wordDiff('', 'x')).toBeNull();
    expect(wordDiff('alpha beta gamma', 'one two three')).toBeNull();
  });

  it('marks only the changed words', () => {
    const a = '  const timeout = 30 * 60 * 1000;';
    const b = '  const timeout = 15 * 60 * 1000;';
    const d = wordDiff(a, b)!;
    expect(pick(a, d.a)).toEqual(['30']);
    expect(pick(b, d.b)).toEqual(['15']);
  });

  it('marks insertions on one side only', () => {
    const a = 'if (!session) return deny(res);';
    const b = 'if (!session || session.revoked) return deny(res);';
    const d = wordDiff(a, b)!;
    expect(d.a).toEqual([]);
    expect(pick(b, d.b)).toEqual(['|| session.revoked']);
  });

  it('merges neighbouring changes separated only by whitespace', () => {
    const a = 'return deny(res, "expired", 401);';
    const b = 'return deny(res, "session_expired", 403);';
    const d = wordDiff(a, b)!;
    expect(pick(b, d.b)).toEqual(['session_expired', '403']);
    expect(pick(a, d.a)).toEqual(['expired', '401']);
  });
});
