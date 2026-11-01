import { Navigate, useLocation } from '@solidjs/router';
import { type JSX, Show } from 'solid-js';
import { auth } from '../lib/auth';

export function RequireAuth(props: { children: JSX.Element; admin?: boolean }) {
  const location = useLocation();
  return (
    <Show
      when={auth.user() && (!props.admin || auth.isAdmin())}
      fallback={<Navigate href={`/login?next=${encodeURIComponent(location.pathname)}`} />}
    >
      {props.children}
    </Show>
  );
}
