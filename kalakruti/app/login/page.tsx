import { authMode } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const mode = authMode();
  return (
    <main className="login">
      <div className="panel">
        <div className="brand" style={{ marginBottom: 16 }}>
          <span className="brand-mark">₹</span> Payment Reminders
        </div>
        {mode === "misconfigured" ? (
          <p className="form-msg err">
            Login is not configured.
          </p>
        ) : (
          <LoginForm />
        )}
      </div>
    </main>
  );
}
