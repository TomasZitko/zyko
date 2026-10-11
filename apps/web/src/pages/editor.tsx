import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyOps, findNode, newNodeId, walk, type EditOp, type PageDocument, type PageNode, type PropField, type ComponentDefinition } from "@zyko/contracts";
import { renderDocument, editorCanvasDocument } from "@zyko/renderer";
import { api, ApiError, errorText } from "../lib/api";
import { useApi } from "../lib/hooks";
import { registry } from "../lib/registry";
import { ErrorBox, Field, Loading, fmtDate } from "../components/ui";

/**
 * Editor engine. Knows nothing about specific components: the palette, property panel, tree labels
 * and canvas all come from the design registry (field descriptors + render functions).
 * Every change is an EditOp applied locally, pushed onto undo history and autosaved in order.
 */
type Entry = { ops: EditOp[]; inverse: EditOp[]; key?: string; at: number };
type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
const DEVICES = { desktop: "100%", tablet: "820px", mobile: "390px" } as const;

export default function Editor({ projectId }: { projectId: string }) {
  const project = useApi<{ project: any }>(`/api/projects/${projectId}`);
  const pagesApi = useApi<{ pages: any[] }>(`/api/projects/${projectId}/pages`);
  const ds = useApi<{ designSystem: any; components: any[]; templates: any[] }>(`/api/projects/${projectId}/design-system`);
  const assetsApi = useApi<{ assets: any[] }>(`/api/projects/${projectId}/assets`);
  const [pageId, setPageId] = useState<string | null>(null);
  useEffect(() => { if (!pageId && pagesApi.data?.pages.length) setPageId(pagesApi.data.pages.find((p) => p.path === "/")?.id ?? pagesApi.data.pages[0].id); }, [pagesApi.data, pageId]);
  if (project.error || pagesApi.error || ds.error) return <ErrorBox error={project.error ?? pagesApi.error ?? ds.error} />;
  if (!project.data || !pagesApi.data || !ds.data || !pageId) return <Loading what="Loading editor" />;
  return (
    <PageEditor key={pageId} projectId={projectId} pageId={pageId} pages={pagesApi.data.pages} onSwitchPage={setPageId} reloadPages={pagesApi.reload}
      site={project.data.project.website} catalogue={ds.data.components} templates={ds.data.templates} assets={assetsApi.data?.assets ?? []} />
  );
}

function PageEditor(props: { projectId: string; pageId: string; pages: any[]; onSwitchPage: (id: string) => void; reloadPages: () => void; site: any; catalogue: any[]; templates: any[]; assets: any[] }) {
  const { site } = props;
  const dsId = site.designSystem.id, dsVer = site.designSystem.version;
  const [doc, setDoc] = useState<PageDocument | null>(null);
  const [meta, setMeta] = useState<{ title: string; path: string; seo: any } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [device, setDevice] = useState<keyof typeof DEVICES>("desktop");
  const [save, setSave] = useState<SaveState>("saved");
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<Entry[]>([]);
  const [redo, setRedo] = useState<Entry[]>([]);
  const [revTick, setRevTick] = useState(0);
  const docRef = useRef<PageDocument | null>(null);
  const version = useRef(0);
  const pending = useRef<{ ops: EditOp[]; meta?: { title?: string; seo?: any } }>({ ops: [] });
  const inflight = useRef(false);
  const timer = useRef<number | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);

  const load = useCallback(async () => {
    const r = await api(`/api/pages/${props.pageId}`);
    docRef.current = r.page.document;
    version.current = r.page.version;
    pending.current = { ops: [] };
    setDoc(r.page.document);
    setMeta({ title: r.page.title, path: r.page.path, seo: r.page.seo ?? {} });
    setUndo([]); setRedo([]); setSave("saved"); setSelected(null);
  }, [props.pageId]);
  useEffect(() => { load().catch((e) => setNotice(errorText(e))); }, [load]);

  // ── Autosave: ordered, batched, optimistic-concurrency ──
  const flush = useCallback(async () => {
    if (inflight.current) return;
    const batch = { ops: pending.current.ops.slice(0, 200), meta: pending.current.meta };
    if (!batch.ops.length && !batch.meta) return;
    inflight.current = true;
    setSave("saving");
    try {
      const r = await api(`/api/pages/${props.pageId}/ops`, { body: { baseVersion: version.current, ops: batch.ops, meta: batch.meta } });
      version.current = r.page.version;
      pending.current.ops = pending.current.ops.slice(batch.ops.length);
      if (pending.current.meta === batch.meta) delete pending.current.meta;
      inflight.current = false;
      if (pending.current.ops.length || pending.current.meta) void flush();
      else { setSave("saved"); setRevTick((t) => t + 1); }
    } catch (e) {
      inflight.current = false;
      if (e instanceof ApiError && e.status === 409) { setSave("conflict"); setNotice("This page was changed elsewhere (for example by the assistant). Reload to continue."); }
      else { setSave("error"); setNotice(errorText(e)); }
    }
  }, [props.pageId]);
  const schedule = useCallback(() => {
    setSave("dirty");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 600);
  }, [flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (pending.current.ops.length || inflight.current) { e.preventDefault(); } };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); if (timer.current) { window.clearTimeout(timer.current); void flush(); } };
  }, [flush]);

  /** Applies ops locally after validating, records history, queues for save. */
  const commit = useCallback((ops: EditOp[], opts: { key?: string; history?: "push" | "undo" | "redo" } = {}) => {
    if (!docRef.current || save === "conflict") return false;
    let result;
    try { result = applyOps(docRef.current, ops); } catch (e) { setNotice((e as Error).message); return false; }
    const issues = registry.validateDocument(dsId, dsVer, result.doc);
    if (issues.length) { setNotice(`${issues[0].message}${issues[0].path ? ` (${issues[0].path})` : ""}`); return false; }
    setNotice(null);
    docRef.current = result.doc;
    setDoc(result.doc);
    pending.current.ops.push(...ops);
    const entry: Entry = { ops, inverse: result.inverse, key: opts.key, at: Date.now() };
    if (!opts.history || opts.history === "push") {
      setUndo((u) => {
        const last = u[u.length - 1];
        if (opts.key && last?.key === opts.key && entry.at - last.at < 1500) return [...u.slice(0, -1), { ...last, ops, at: entry.at }];
        return [...u.slice(-199), entry];
      });
      setRedo([]);
    }
    schedule();
    return entry;
  }, [dsId, dsVer, schedule, save]);

  const doUndo = useCallback(() => {
    const e = undo[undo.length - 1];
    if (!e) return;
    if (commit(e.inverse, { history: "undo" })) { setUndo((u) => u.slice(0, -1)); setRedo((r) => [...r, e]); }
  }, [undo, commit]);
  const doRedo = useCallback(() => {
    const e = redo[redo.length - 1];
    if (!e) return;
    const res = commit(e.ops, { history: "redo" });
    if (res) { setRedo((r) => r.slice(0, -1)); setUndo((u) => [...u, { ...e, inverse: res.inverse }]); }
  }, [redo, commit]);

  const updateMeta = (patch: { title?: string; seo?: any }) => {
    setMeta((m) => (m ? { ...m, ...patch } : m));
    pending.current.meta = { ...(pending.current.meta ?? {}), ...patch };
    schedule();
  };

  // ── Canvas ──
  const assetMap = useMemo(() => new Map(props.assets.map((a) => [a.id, a])), [props.assets]);
  const rendered = useMemo(() => {
    if (!doc) return null;
    return renderDocument(doc, {
      registry, designSystem: { id: dsId, version: dsVer }, target: "editor", site: site.settings,
      pages: props.pages.map((p) => ({ path: p.path, title: p.title })),
      resolveAsset: (id) => { const a = assetMap.get(id); return a ? { id: a.id, url: new URL(a.url, location.origin).href, alt: a.alt ?? "", width: a.width, height: a.height, mime: a.mime } : null; },
    });
  }, [doc, assetMap, dsId, dsVer, site.settings, props.pages]);
  const postRender = useCallback(() => {
    if (!ready.current || !rendered) return;
    frame.current?.contentWindow?.postMessage({ type: "zyko:render", body: rendered.body, css: rendered.css, selectedId: selected }, "*");
  }, [rendered, selected]);
  useEffect(postRender, [postRender]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const m = e.data ?? {};
      if (m.type === "zyko:ready") { ready.current = true; postRender(); }
      if (m.type === "zyko:select") setSelected(typeof m.nodeId === "string" ? m.nodeId : null);
      if (m.type === "zyko:inline-edit" && typeof m.nodeId === "string" && typeof m.prop === "string") {
        const n = docRef.current && findNode(docRef.current, m.nodeId);
        const def = n && registry.component(dsId, dsVer, n.type);
        const field = def?.fields[m.prop];
        if (n && field && "inline" in field && field.inline && n.props[m.prop] !== m.value) commit([{ op: "update_props", nodeId: m.nodeId, props: { [m.prop]: String(m.value).slice(0, 10000) } }]);
        else postRender();
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [commit, postRender, dsId, dsVer]);
  const canvasDoc = useMemo(() => editorCanvasDocument(), []);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y" && !typing) { e.preventDefault(); doRedo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doUndo, doRedo]);

  if (!doc || !meta) return notice ? <ErrorBox error={notice} /> : <Loading what="Loading page" />;
  const selNode = selected ? findNode(doc, selected) : null;
  const selDef = selNode ? registry.component(dsId, dsVer, selNode.type) : null;

  // ── Structural actions ──
  const locate = (id: string): { parentId: string | null; slot?: string; index: number; siblings: PageNode[] } | null => {
    let out: any = null;
    const scan = (nodes: PageNode[], parent: PageNode | null, slot?: string) => nodes.forEach((n, i) => {
      if (n.id === id) out = { parentId: parent?.id ?? null, slot, index: i, siblings: nodes };
      for (const [s, ch] of Object.entries(n.slots ?? {})) scan(ch, n, s);
    });
    scan(doc.root, null);
    return out;
  };
  const insert = (type: string) => {
    const node = registry.createNode(dsId, dsVer, type, newNodeId());
    let target: { parentId: string | null; slot?: string; index: number } = { parentId: null, index: doc.root.length };
    if (selNode && selDef?.slots) {
      const slot = Object.keys(selDef.slots)[0];
      target = { parentId: selNode.id, slot, index: selNode.slots?.[slot]?.length ?? 0 };
    } else if (selNode) {
      const loc = locate(selNode.id)!;
      target = { parentId: loc.parentId, slot: loc.slot, index: loc.index + 1 };
    }
    if (commit([{ op: "insert", ...target, node }])) setSelected(node.id);
  };
  const move = (dir: -1 | 1) => {
    if (!selNode) return;
    const loc = locate(selNode.id)!;
    const to = loc.index + dir;
    if (to < 0 || to >= loc.siblings.length) return;
    commit([{ op: "move", nodeId: selNode.id, parentId: loc.parentId, slot: loc.slot, index: to }]);
  };
  const remove = () => { if (selNode && commit([{ op: "remove", nodeId: selNode.id }])) setSelected(null); };
  const duplicate = () => {
    if (!selNode) return;
    const loc = locate(selNode.id)!;
    const copy: PageNode = structuredClone(selNode);
    walk([copy], (n) => { n.id = newNodeId(); });
    if (commit([{ op: "insert", parentId: loc.parentId, slot: loc.slot, index: loc.index + 1, node: copy }])) setSelected(copy.id);
  };

  return (
    <div className="stack">
      <div className="editor">
        <aside aria-label="Pages and layers" className="stack">
          <PagesPanel {...props} />
          <div>
            <h3>Layers</h3>
            <Tree nodes={doc.root} selected={selected} onSelect={setSelected} dsId={dsId} dsVer={dsVer} root />
            {doc.root.length === 0 && <p className="small muted">Empty page. Insert a component below.</p>}
          </div>
          <InsertPanel catalogue={props.catalogue} selDef={selDef} selNode={selNode} onInsert={insert} />
        </aside>
        <div className="stage">
          <div className="toolbar" role="toolbar" aria-label="Editor">
            <button className="btn sm" onClick={doUndo} disabled={!undo.length} aria-label="Undo" title="Undo (Ctrl+Z)">↶ Undo</button>
            <button className="btn sm" onClick={doRedo} disabled={!redo.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
            <span style={{ width: 8 }} />
            {(Object.keys(DEVICES) as (keyof typeof DEVICES)[]).map((d) => (
              <button key={d} className={`btn sm ${device === d ? "primary" : ""}`} aria-pressed={device === d} onClick={() => setDevice(d)}>{d}</button>
            ))}
            <span style={{ flex: 1 }} />
            <span className={`badge ${save === "saved" ? "ok" : save === "error" || save === "conflict" ? "err" : "warn"}`} role="status" aria-live="polite" data-testid="save-state">
              {save === "saved" ? "All changes saved" : save === "saving" ? "Saving…" : save === "dirty" ? "Unsaved changes" : save === "conflict" ? "Conflict" : "Save failed"}
            </span>
            {save === "conflict" && <button className="btn sm" onClick={() => load()}>Reload</button>}
            {save === "error" && <button className="btn sm" onClick={() => flush()}>Retry</button>}
          </div>
          {notice && <div className="alert error small" role="alert" style={{ margin: 8 }}>{notice}</div>}
          <div className="canvas-wrap">
            <iframe ref={frame} title="Page canvas" sandbox="allow-scripts" srcDoc={canvasDoc} style={{ width: DEVICES[device] }} />
          </div>
        </div>
        <aside className="right stack" aria-label="Properties">
          {selNode && selDef ? (
            <>
              <div className="row spread"><h3>{selDef.displayName}</h3><button className="btn sm ghost" onClick={() => setSelected(null)} aria-label="Deselect">✕</button></div>
              <div className="row">
                <button className="btn sm" onClick={() => move(-1)} aria-label="Move up">↑</button>
                <button className="btn sm" onClick={() => move(1)} aria-label="Move down">↓</button>
                <button className="btn sm" onClick={duplicate}>Duplicate</button>
                <button className="btn sm danger" onClick={remove}>Delete</button>
              </div>
              <PropsForm def={selDef} node={selNode} assets={props.assets} onChange={(key, value) => commit([{ op: "update_props", nodeId: selNode.id, props: { [key]: value } }], { key: `${selNode.id}:${key}` })} />
              {selDef.responsive?.hideable && (
                <fieldset className="stack" style={{ border: 0, padding: 0 }}>
                  <legend style={{ fontWeight: 600 }}>Visibility</legend>
                  {(["mobile", "tablet", "desktop"] as const).map((b) => (
                    <label key={b} className="row small"><input type="checkbox" checked={selNode.layout?.hideOn?.includes(b) ?? false} onChange={(e) => {
                      const cur = new Set(selNode.layout?.hideOn ?? []);
                      e.target.checked ? cur.add(b) : cur.delete(b);
                      commit([{ op: "set_layout", nodeId: selNode.id, layout: { hideOn: [...cur] } }]);
                    }} /> Hide on {b}</label>
                  ))}
                </fieldset>
              )}
            </>
          ) : (
            <PageSettings meta={meta} onChange={updateMeta} />
          )}
          <Revisions pageId={props.pageId} tick={revTick} onRestored={load} />
        </aside>
      </div>
    </div>
  );
}

function label(n: PageNode, def: ComponentDefinition | null) {
  const text = (n.props.text ?? n.props.label ?? n.props.body ?? "") as string;
  return `${def?.displayName.replace(/ \(.*\)$/, "") ?? n.type}${text ? ` — ${String(text).slice(0, 24)}` : ""}`;
}

function Tree({ nodes, selected, onSelect, dsId, dsVer, root }: { nodes: PageNode[]; selected: string | null; onSelect: (id: string) => void; dsId: string; dsVer: string; root?: boolean }) {
  return (
    <ul className={`tree ${root ? "root" : ""}`} role={root ? "tree" : "group"}>
      {nodes.map((n) => (
        <li key={n.id} role="treeitem" aria-selected={selected === n.id}>
          <button className={`node ${selected === n.id ? "sel" : ""}`} onClick={() => onSelect(n.id)}>{label(n, registry.component(dsId, dsVer, n.type))}</button>
          {Object.values(n.slots ?? {}).map((children, i) => children.length ? <Tree key={i} nodes={children} selected={selected} onSelect={onSelect} dsId={dsId} dsVer={dsVer} /> : null)}
        </li>
      ))}
    </ul>
  );
}

function InsertPanel({ catalogue, selDef, selNode, onInsert }: { catalogue: any[]; selDef: ComponentDefinition | null; selNode: PageNode | null; onInsert: (t: string) => void }) {
  const [type, setType] = useState("");
  const intoSlot = !!(selNode && selDef?.slots);
  const allowed = catalogue.filter((c) => {
    if (!selNode) return c.placement !== "nested";
    if (intoSlot) { const s = Object.values(selDef!.slots!)[0]; return c.placement !== "root" && (!s.allow || s.allow.includes(c.type)); }
    return true;
  });
  return (
    <div className="stack">
      <h3>Insert</h3>
      <p className="small muted">{!selNode ? "Adds to the end of the page." : intoSlot ? `Adds inside the selected ${selDef!.displayName}.` : "Adds after the selected component."}</p>
      <div className="row">
        <select aria-label="Component type" value={type} onChange={(e) => setType(e.target.value)} style={{ flex: 1 }}>
          <option value="">Choose component…</option>
          {allowed.map((c) => <option key={c.type} value={c.type}>{c.displayName}</option>)}
        </select>
        <button className="btn sm primary" disabled={!type || !allowed.some((c) => c.type === type)} onClick={() => onInsert(type)}>Insert</button>
      </div>
    </div>
  );
}

function PropsForm({ def, node, assets, onChange }: { def: ComponentDefinition; node: PageNode; assets: any[]; onChange: (k: string, v: unknown) => void }) {
  const entries = Object.entries(def.fields);
  if (!entries.length) return <p className="small muted">This component has no editable properties.</p>;
  return (
    <div className="stack">
      {entries.map(([k, f]) => <FieldInput key={k} field={f} value={node.props[k] ?? def.defaultProps[k]} assets={assets} onChange={(v) => onChange(k, v)} />)}
    </div>
  );
}

/** Generic input for a PropField. Extend here when adding new field types. */
function FieldInput({ field: f, value, assets, onChange }: { field: PropField; value: any; assets: any[]; onChange: (v: unknown) => void }) {
  switch (f.type) {
    case "text": return <Field label={f.label} hint={f.description}><input value={value ?? ""} maxLength={f.maxLength} onChange={(e) => onChange(e.target.value)} /></Field>;
    case "textarea": return <Field label={f.label} hint={f.description}><textarea value={value ?? ""} maxLength={f.maxLength} onChange={(e) => onChange(e.target.value)} /></Field>;
    case "url": return <Field label={f.label} hint={f.description ?? "https://…, /page, #anchor, mailto: or tel:"}><input value={value ?? ""} onChange={(e) => onChange(e.target.value)} /></Field>;
    case "number": return <Field label={f.label}><input type="number" value={value ?? ""} min={f.min} max={f.max} step={f.step} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} /></Field>;
    case "boolean": return <label className="row"><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {f.label}</label>;
    case "select": return <Field label={f.label}><select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>;
    case "color": return (
      <Field label={f.label} hint="Hex color or token:<name>">
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input type="color" aria-label={`${f.label} picker`} value={/^#[0-9a-f]{6}$/i.test(value ?? "") ? value : "#ffffff"} onChange={(e) => onChange(e.target.value)} style={{ width: 44, padding: 2 }} />
          <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
        </div>
      </Field>
    );
    case "asset": {
      const options = assets.filter((a) => !f.accept || f.accept.includes(a.kind));
      return (
        <Field label={f.label} hint={options.length ? undefined : "Upload files in the Assets tab"}>
          <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">None</option>
            {options.map((a) => <option key={a.id} value={a.id}>{a.filename}</option>)}
          </select>
        </Field>
      );
    }
    case "list": {
      const items: any[] = Array.isArray(value) ? value : [];
      return (
        <fieldset className="stack" style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
          <legend>{f.label}</legend>
          {items.map((it, i) => (
            <div key={i} className="stack" style={{ borderBottom: "1px dashed var(--border)", paddingBottom: 8 }}>
              {Object.entries(f.item).map(([k, sub]) => <FieldInput key={k} field={sub} value={it[k]} assets={assets} onChange={(v) => onChange(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)))} />)}
              <button className="btn sm danger" onClick={() => onChange(items.filter((_, j) => j !== i))}>Remove item</button>
            </div>
          ))}
          <button className="btn sm" disabled={items.length >= (f.maxItems ?? 50)} onClick={() => onChange([...items, {}])}>Add item</button>
        </fieldset>
      );
    }
  }
}

function PageSettings({ meta, onChange }: { meta: { title: string; path: string; seo: any }; onChange: (p: { title?: string; seo?: any }) => void }) {
  return (
    <div className="stack">
      <h3>Page settings</h3>
      <p className="small muted">Select a component on the canvas or in Layers to edit it. Double-click text on the canvas to edit inline.</p>
      <Field label="Title"><input value={meta.title} onChange={(e) => onChange({ title: e.target.value })} /></Field>
      <Field label="Path"><input value={meta.path} readOnly /></Field>
      <Field label="SEO title" hint="Defaults to the site title template"><input maxLength={70} value={meta.seo.title ?? ""} onChange={(e) => onChange({ seo: { ...meta.seo, title: e.target.value || undefined } })} /></Field>
      <Field label="Meta description"><textarea maxLength={170} value={meta.seo.description ?? ""} onChange={(e) => onChange({ seo: { ...meta.seo, description: e.target.value || undefined } })} /></Field>
      <label className="row small"><input type="checkbox" checked={!!meta.seo.noindex} onChange={(e) => onChange({ seo: { ...meta.seo, noindex: e.target.checked || undefined } })} /> Hide from search engines</label>
    </div>
  );
}

function PagesPanel({ projectId, pages, pageId, onSwitchPage, reloadPages, templates }: { projectId: string; pages: any[]; pageId: string; onSwitchPage: (id: string) => void; reloadPages: () => void; templates: any[] }) {
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ title: "", path: "/", templateId: "" });
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    try {
      const r = await api(`/api/projects/${projectId}/pages`, { body: { title: f.title, path: f.path, templateId: f.templateId || undefined } });
      setAdding(false); setF({ title: "", path: "/", templateId: "" }); reloadPages(); onSwitchPage(r.page.id);
    } catch (e) { setErr(errorText(e)); }
  };
  return (
    <div className="stack">
      <div className="row spread"><h3>Pages</h3><button className="btn sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>+ Page</button></div>
      <select aria-label="Current page" value={pageId} onChange={(e) => onSwitchPage(e.target.value)}>
        {pages.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.path})</option>)}
      </select>
      {adding && (
        <div className="stack">
          <ErrorBox error={err} />
          <Field label="Title"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value, path: f.path === "/" || f.path === slugPath(f.title) ? slugPath(e.target.value) : f.path })} /></Field>
          <Field label="Path"><input value={f.path} onChange={(e) => setF({ ...f, path: e.target.value })} /></Field>
          {templates.length > 0 && <Field label="Start from"><select value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}><option value="">Empty page</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
          <button className="btn sm primary" onClick={add} disabled={!f.title}>Create page</button>
        </div>
      )}
    </div>
  );
}
const slugPath = (t: string) => "/" + t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function Revisions({ pageId, tick, onRestored }: { pageId: string; tick: number; onRestored: () => void }) {
  const r = useApi<{ revisions: any[] }>(`/api/pages/${pageId}/revisions`, [tick]);
  const [err, setErr] = useState<string | null>(null);
  const restore = async (id: string) => {
    try { await api(`/api/pages/${pageId}/revisions/${id}/restore`, { body: {} }); onRestored(); r.reload(); } catch (e) { setErr(errorText(e)); }
  };
  return (
    <details>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>Version history</summary>
      <ErrorBox error={err} />
      <ol className="stack small" style={{ paddingLeft: 16 }} reversed>
        {r.data?.revisions.map((v, i) => (
          <li key={v.id}>
            <div>v{v.version} · <span className={`badge ${v.source === "ai" ? "warn" : ""}`}>{v.source}</span> {v.authorName ?? ""}</div>
            <div className="muted">{fmtDate(v.createdAt)}{v.message ? ` · ${v.message}` : ""}{v.opCount ? ` · ${v.opCount} change(s)` : ""}</div>
            {i > 0 && <button className="btn sm" onClick={() => restore(v.id)}>Restore</button>}
          </li>
        ))}
      </ol>
    </details>
  );
}
