import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Loading, fmtDate } from "../components/ui";

export default function Notifications() {
  const n = useApi<{ notifications: any[]; unread: number }>("/api/notifications");
  if (!n.data) return <Loading />;
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="row spread"><h1>Notifications</h1><button className="btn sm" onClick={async () => { await api("/api/notifications/read", { body: {} }); n.reload(); }}>Mark all read</button></div>
      {n.data.notifications.length === 0 && <p className="muted">Nothing yet.</p>}
      {n.data.notifications.map((x) => (
        <div key={x.id} className="card" style={{ opacity: x.readAt ? 0.7 : 1 }}>
          <strong>{x.title}</strong> {x.link && <Link to={x.link}>Open</Link>}
          {x.body && <p className="small">{x.body}</p>}
          <div className="small muted">{fmtDate(x.createdAt)}</div>
        </div>
      ))}
    </div>
  );
}
