/**
 * What a server action hands back to `useActionState`.
 *
 * Its own module rather than `actions.ts`, because a `'use server'` file may only export async
 * functions. A type would be erased and get away with it; a `const` would not.
 */

/** Form field name to the messages to render under it. */
export type FieldErrors = Record<string, string[]>;

export interface FormState {
  status: 'idle' | 'created' | 'rejected';
  errors: FieldErrors;
  /** What to say once the row is in. */
  created?: string;
}

export const EMPTY_FORM_STATE: FormState = { status: 'idle', errors: {} };
