"use client";

import { useActionState } from "react";
import { login } from "../actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <form action={action} className="form-grid stack">
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoFocus required autoComplete="current-password" />
      </div>
      <button className="btn btn-primary" disabled={pending} style={{ justifyContent: "center" }}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {state?.error && <p className="form-msg err">{state.error}</p>}
    </form>
  );
}
