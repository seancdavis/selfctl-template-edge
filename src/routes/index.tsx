import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

// The template-owned admin page. Unlocks with AGENT_ADMIN_KEY (never persisted
// — held only in component state) to reveal the connection token and pick a
// model. Every call here goes through the kit's own admin routes under
// /agent/config/*; this page has no server functions and no protocol logic
// of its own.

export const Route = createFileRoute("/")({
  component: Home,
});

interface Settings {
  model: string;
  models: { id: string; label: string }[];
}

function Home() {
  const [adminKey, setAdminKey] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState<string | null>(null);

  // Computed client-side only — `window` doesn't exist during SSR, and the
  // page must still render the shell + unlock form on the server.
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  async function unlock() {
    setUnlockError(null);
    const key = adminKey.trim();
    if (!key) return;

    const headers = { Authorization: `Bearer ${key}` };
    const [tokenRes, settingsRes] = await Promise.all([
      fetch("/agent/config/token", { headers }),
      fetch("/agent/config/settings", { headers }),
    ]);

    if (tokenRes.status === 401 || settingsRes.status === 401) {
      setUnlockError("Wrong key");
      return;
    }
    if (!tokenRes.ok || !settingsRes.ok) {
      setUnlockError(`Unexpected error (${tokenRes.status || settingsRes.status})`);
      return;
    }

    const tokenData = (await tokenRes.json()) as { connectionToken: string };
    const settingsData = (await settingsRes.json()) as Settings;
    setToken(tokenData.connectionToken);
    setSettings(settingsData);
  }

  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API unavailable; field is still selectable.
    }
  }

  async function changeModel(model: string) {
    setSaveStatus("Saving…");
    const res = await fetch("/agent/config/settings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${adminKey.trim()}`,
      },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) {
      setSaveStatus(`Error (${res.status})`);
      return;
    }
    const data = (await res.json()) as { model: string };
    setSettings((prev) => (prev ? { ...prev, model: data.model } : prev));
    setSaveStatus("Saved");
  }

  return (
    <main style={{ maxWidth: "32rem", margin: "3rem auto", fontFamily: "sans-serif" }}>
      <style>{`
        input, select, button { font: inherit; padding: 0.4rem 0.6rem; }
        .row { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem; }
        .muted { opacity: 0.7; font-size: 0.9em; }
        .error { color: #c33; }
      `}</style>
      <h1>selfctl agent</h1>

      {settings === null && (
        <section>
          <h2>Admin key</h2>
          <div className="row">
            <input
              type="password"
              placeholder="Admin key"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && unlock()}
            />
            <button type="button" onClick={unlock}>Unlock</button>
          </div>
          {unlockError && <p className="error">{unlockError}</p>}
        </section>
      )}

      {settings !== null && (
        <section>
          <h2>Connection token</h2>
          <div className="row">
            <input type="text" readOnly value={token ?? ""} style={{ flex: 1 }} />
            <button type="button" onClick={copyToken}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <p className="muted">
            Paste this token and the base URL <code>{(origin ?? "") + "/agent"}</code> into a
            client.
          </p>

          <h2>Model</h2>
          <div className="row">
            <select value={settings.model} onChange={(e) => changeModel(e.target.value)}>
              {settings.models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
          {saveStatus && <p className="muted">{saveStatus}</p>}
        </section>
      )}
    </main>
  );
}
