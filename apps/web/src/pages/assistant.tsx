import { useEffect, useRef, useState } from "react";
import { api, errorText, streamSSE } from "../lib/api";
import { useApi } from "../lib/hooks";
import { ErrorBox, Loading, StatusBadge } from "../components/ui";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };
type Msg = { id: string; role: "user" | "assistant"; content: Block[]; status?: string };

export default function Assistant({ projectId }: { projectId: string }) {
  const convs = useApi<{ conversations: any[] }>(`/api/projects/${projectId}/conversations`);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => { if (!active && convs.data?.conversations[0]) setActive(convs.data.conversations[0].id); }, [convs.data, active]);
  const create = async () => {
    const r = await api(`/api/projects/${projectId}/conversations`, { body: { title: `Conversation ${new Date().toLocaleDateString()}` } });
    await convs.reload();
    setActive(r.conversation.id);
  };
  return (
    <div className="chat">
      <aside className="stack">
        <button className="btn primary" onClick={create}>New conversation</button>
        <nav aria-label="Conversations" className="stack">
          {convs.data?.conversations.map((c) => (
            <button key={c.id} className={`btn ${active === c.id ? "primary" : ""}`} onClick={() => setActive(c.id)} style={{ justifyContent: "flex-start", overflow: "hidden" }}>{c.title}</button>
          ))}
        </nav>
        <p className="small muted">The assistant reads your project brief and site structure and changes content only through validated operations. Publishing always asks for your approval.</p>
      </aside>
      {active ? <Conversation key={active} id={active} /> : <div className="card muted">Start a conversation.</div>}
    </div>
  );
}

function Conversation({ id }: { id: string }) {
  const c = useApi<{ conversation: any; messages: Msg[]; tasks: any[] }>(`/api/conversations/${id}`);
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [live, setLive] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [c.data, streaming, live]);

  const send = async () => {
    if (!text.trim()) return;
    const msg = text;
    setText(""); setErr(null); setStreaming(""); setLive([`You: ${msg}`]);
    try {
      await streamSSE(`/api/conversations/${id}/messages`, { text: msg }, (event, data) => {
        if (event === "text") setStreaming((s) => (s ?? "") + data.delta);
        if (event === "message_start") setStreaming((s) => { if (s) setLive((l) => [...l, s]); return ""; });
        if (event === "tool_call") setLive((l) => [...l, `→ ${data.name}`]);
        if (event === "tool_result") setLive((l) => [...l, `${data.ok ? "✓" : "✗"} ${data.name}`]);
        if (event === "approval_required") setLive((l) => [...l, `⏸ ${data.name} needs your approval`]);
        if (event === "error") setErr(data.message);
      });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setStreaming(null); setLive([]);
      await c.reload();
    }
  };
  const decide = async (taskId: string, d: "approve" | "reject") => {
    try { await api(`/api/ai-tasks/${taskId}/${d}`, { body: {} }); } catch (e) { setErr(errorText(e)); }
    await c.reload();
  };
  if (!c.data) return c.error ? <ErrorBox error={c.error} /> : <Loading />;
  const tasks = new Map(c.data.tasks.map((t) => [t.toolUseId, t]));
  return (
    <section className="card stack" aria-label="Conversation">
      <div className="log" ref={logRef} aria-live="polite">
        {c.data.messages.map((m) => m.content.map((b, i) => {
          if (b.type === "text") return <div key={`${m.id}${i}`} className={`msg ${m.role}`}>{b.text}</div>;
          if (b.type === "tool_use") {
            const t = tasks.get(b.id);
            return (
              <div key={`${m.id}${i}`} className="msg">
                <div className="tool">tool: {b.name} {t && <StatusBadge status={t.status} />}</div>
                <details className="small"><summary>Input</summary><pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(b.input, null, 2)}</pre></details>
                {t?.status === "awaiting_approval" && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn sm primary" onClick={() => decide(t.id, "approve")}>Approve</button>
                    <button className="btn sm" onClick={() => decide(t.id, "reject")}>Reject</button>
                  </div>
                )}
                {t?.error && <div className="small" style={{ color: "var(--danger)" }}>{t.error}</div>}
              </div>
            );
          }
          return null;
        }))}
        {live.map((l, i) => <div key={`live${i}`} className="msg small muted">{l}</div>)}
        {streaming !== null && <div className="msg assistant">{streaming || "…"}</div>}
      </div>
      <ErrorBox error={err} />
      <form className="row" style={{ flexWrap: "nowrap" }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor="chat-input">Message</label>
        <textarea id="chat-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about the project or request a change…" style={{ minHeight: 44 }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="btn primary" disabled={streaming !== null || !text.trim()}>Send</button>
      </form>
    </section>
  );
}
