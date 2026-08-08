'use client';

/**
 * The form. It knows the field names and nothing else.
 *
 * Every message under every input came out of `constraintForIssue` on the server, keyed by the
 * constraint that produced it, so no rule is restated here. The nested rows are named
 * `posts[0].title` and so on, matching the keys the action builds from the relation key in the
 * nested payload.
 */
import { useActionState, type InputHTMLAttributes } from 'react';
import { EMPTY_FORM_STATE, type FieldErrors, type FormState } from '../lib/form-state';

type Action = (state: FormState, data: FormData) => Promise<FormState>;

function Messages({ errors, field }: { errors: FieldErrors; field: string }) {
  const messages = errors[field];
  if (!messages?.length) return null;
  return (
    <ul style={{ color: '#b3261e', listStyle: 'none', margin: '0.25rem 0 0', padding: 0 }}>
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

function Field({
  label,
  name,
  field,
  errors,
  ...input
}: {
  label: string;
  name: string;
  field: string;
  errors: FieldErrors;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <p>
      <label htmlFor={name} style={{ display: 'block', fontWeight: 600 }}>
        {label}
      </label>
      <input id={name} name={name} style={{ width: '100%' }} {...input} />
      <Messages errors={errors} field={field} />
    </p>
  );
}

export function AuthorForm({ action, withPosts = false }: { action: Action; withPosts?: boolean }) {
  const [state, submit, pending] = useActionState(action, EMPTY_FORM_STATE);

  return (
    <form action={submit}>
      {/* 3 to 20 characters, and unique. All three facts live in the Drizzle schema and reach
          this form only as messages the server attributed to a named constraint. */}
      <Field label="Handle" name="handle" field="handle" errors={state.errors} defaultValue="ada" />
      <Field label="Email" name="email" field="email" errors={state.errors} />
      <Field label="Age" name="age" field="age" errors={state.errors} inputMode="numeric" />

      {withPosts &&
        [0, 1].map((i) => (
          <fieldset key={i} style={{ margin: '1rem 0' }}>
            <legend>Post {i + 1}</legend>
            <Field
              label="Title"
              name="postTitle"
              field={`posts[${i}].title`}
              errors={state.errors}
            />
            <Field
              label="Status"
              name="postStatus"
              field={`posts[${i}].status`}
              errors={state.errors}
              placeholder="draft or live"
            />
          </fieldset>
        ))}

      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </button>

      {state.status === 'created' && <p role="status">Saved {state.created}.</p>}
      <Messages errors={state.errors} field="form" />
    </form>
  );
}
