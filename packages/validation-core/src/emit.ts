/**
 * Where a generator's files go, so that "write it" and "tell me what you would write" are the same
 * code path (plan items 68, 80, 81).
 *
 * Three requests turn out to be one mechanism. `--dry-run` needs to know what would be written
 * without writing it, `generate` needs to say which files it created and which it changed rather
 * than only how many it wrote, and `--check` needs to show a diff of the difference. All three are
 * the same question asked per file: what content is about to land here, and what is here now. The
 * only thing a generator has to give up for that is deciding, itself, that the answer goes to disk.
 *
 * ## Why an option and not an interception
 *
 * The tempting version is to leave every generator alone and patch `node:fs/promises` for the
 * duration of the run, since each one reaches it through `await import('node:fs/promises')`. That
 * was measured and rejected. Patching the CommonJS exports object is visible through a later
 * dynamic import, but a module namespace that already exists is a snapshot and never changes:
 *
 *   const ns = await import('node:fs/promises');       // namespace built here
 *   require('node:fs/promises').writeFile = spy;       // patch applied after
 *   ns.writeFile === spy                               // false, measured on Node 22.22
 *
 * The CLI links `chokidar`, which imports `node:fs/promises` at module scope, so by the time any
 * command body runs the namespace usually exists and the patch is invisible. A dry run built on
 * that would write real files whenever an unrelated dependency happened to import first, which is
 * the worst possible failure for this feature: silent, environmental, and destructive. An explicit
 * option cannot fail that way, because a generator that never received a sink is a generator whose
 * call site can be read.
 *
 * ## Shape
 *
 * `fileWriter` returns an object with the two methods every generator already calls on the
 * `node:fs/promises` namespace, with the same signatures, so adopting it is one line per generator
 * and no write site changes at all:
 *
 *   const fs = await import('node:fs/promises');   ->   const fs = fileWriter(opts.fileSink);
 *
 * That matters more than it looks. Fourteen generators write files, between one and six times
 * each, and a change that touched every one of those sites would be fourteen chances to miss one
 * and ship a dry run that writes.
 */

/**
 * Somewhere for a generator's output to go that is not the filesystem.
 *
 * `mkdir` is part of it because a dry run that creates directories is not a dry run: run in an
 * empty project, the honest answer leaves the directory empty, and `fs.mkdir(out, { recursive:
 * true })` is the first thing every generator does.
 */
export interface FileSink {
  mkdir(dir: string): void | Promise<void>;
  writeFile(file: string, contents: string): void | Promise<void>;
}

/**
 * The `node:fs/promises` subset generators use, narrowed to the two calls they actually make.
 *
 * Declared structurally rather than imported from `node:fs` so that the real namespace satisfies
 * it without a cast and a sink can too. The `options` and `encoding` parameters are accepted and
 * ignored by a sink: every call site in this repository passes `{ recursive: true }` and `'utf8'`,
 * and a sink that took different arguments would make the swap a rewrite rather than a rename.
 */
export interface GeneratorFs {
  mkdir(dir: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(file: string, contents: string, encoding?: BufferEncoding): Promise<void>;
}

/**
 * `node:fs/promises`, imported at most once per process.
 *
 * Lazily, because that is how every generator reached it before this file existed and a static
 * import would put `node:fs` in the module graph of a package whose other exports are pure string
 * work. Once, rather than per call, because the alternative is a dynamic import per written file
 * and a generator emitting six hundred modules would perform six hundred of them for no reason.
 */
let realFs: Promise<typeof import('node:fs/promises')> | null = null;
function nodeFs() {
  return (realFs ??= import('node:fs/promises'));
}

/**
 * The filesystem, or whatever was passed instead of it.
 *
 * Without a sink this is `node:fs/promises` itself, so a run with no sink performs the same calls
 * in the same order as before this existed.
 */
export function fileWriter(sink?: FileSink): GeneratorFs {
  if (!sink) {
    return {
      async mkdir(dir: string, options?: { recursive?: boolean }) {
        return (await nodeFs()).mkdir(dir, options);
      },
      async writeFile(file: string, contents: string, encoding: BufferEncoding = 'utf8') {
        return (await nodeFs()).writeFile(file, contents, encoding);
      },
    };
  }
  return {
    async mkdir(dir: string) {
      await sink.mkdir(dir);
      return undefined;
    },
    async writeFile(file: string, contents: string) {
      await sink.writeFile(file, contents);
    },
  };
}
