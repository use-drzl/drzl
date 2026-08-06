/**
 * Loading an optional generator package, and telling absence apart from failure.
 *
 * Every validation generator is loaded on demand, because a project that only wants zod should not
 * have to install five. That makes "the package is not installed" a real, expected outcome worth a
 * helpful message. It does not make it the only outcome: a generator that is installed and running
 * can throw for any reason a program can throw, and the CLI reported all of those as a missing npm
 * package too, with the true reason printed underneath as a detail.
 *
 * Node reports an unresolvable import as `ERR_MODULE_NOT_FOUND`, and reports the same code when
 * the module resolved and something *it* imported did not. The code alone therefore does not
 * separate the two; the message does, because it names the specifier that failed to resolve.
 */

/** A generator package that is not installed. Everything else is somebody's real error. */
export class GeneratorNotInstalledError extends Error {
  constructor(
    readonly specifier: string,
    /** What Node threw, kept so nothing is discarded on the way to the message. */
    readonly reason: unknown
  ) {
    super(`${specifier} is not installed`);
    this.name = 'GeneratorNotInstalledError';
  }
}

/**
 * Whether `err` is Node refusing to resolve `specifier` itself.
 *
 * Measured on Node 22, from an ESM entry and from a CJS one, since the CLI ships both builds and
 * the bundler leaves `import()` as `import()` in each:
 *
 *   absent package            ERR_MODULE_NOT_FOUND, `Cannot find package '<specifier>' imported…`
 *   present, inner dep absent ERR_MODULE_NOT_FOUND, naming the *inner* specifier instead
 *   present, main file gone   ERR_MODULE_NOT_FOUND, naming the resolved file path
 *   throws while evaluating   no `code` at all, and whatever message the generator threw
 *
 * Only the first is an install problem, and only the first quotes the specifier that was asked
 * for, which is what this matches on.
 */
export function isPackageMissing(err: unknown, specifier: string): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code !== 'ERR_MODULE_NOT_FOUND') return false;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.includes(`'${specifier}'`);
}

/**
 * Run `load` and re-throw a missing package as `GeneratorNotInstalledError`.
 *
 * `load` is a thunk rather than a specifier so the caller keeps a literal `import('@drzl/…')` in
 * its own source, which is what lets the bundler see the dependency. Anything it throws that is
 * not this package's own absence comes out unchanged.
 */
export async function loadGenerator<T>(specifier: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (e) {
    if (isPackageMissing(e, specifier)) throw new GeneratorNotInstalledError(specifier, e);
    throw e;
  }
}
