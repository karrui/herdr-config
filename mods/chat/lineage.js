import { modelName, levelName } from "./agent.js";

export function storedTerminals(list, owner, out = new Map()) {
  for (const h of list) {
    if (h.terminal) {
      if (out.has(h.terminal)) continue;
      out.set(h.terminal, { ...h, parentTerminal: h.parentTerminal ?? owner, children: (h.children ?? []).filter(c => !c.terminal) });
      storedTerminals(h.children ?? [], h.terminal, out);
    }
  }
  return out;
}

export function descendantTerminals(core, owner) {
  if (!owner) return [];
  const result = [], queue = [owner], seen = new Set(queue);
  for (let i = 0; i < queue.length && result.length < 128; i++) for (const k of core) {
    if (k.parent !== queue[i] || seen.has(k.address)) continue;
    seen.add(k.address); queue.push(k.address); result.push(k);
  }
  return result;
}

export function conversationTitle(terminal, panes, spaces) {
  if (!terminal) return "Parent conversation";
  const pane = panes.find(p => p.terminal === terminal?.address || (terminal?.labels?.["herdr.chat"] && p.pane === terminal.labels["herdr.chat"]));
  const space = spaces.find(s => s.tabs.some(t => t.id === pane?.tab)), tab = space?.tabs.find(t => t.id === pane?.tab);
  const place = [space?.named ? space.name : null, tab?.named ? tab.name : null].filter(Boolean).join(" · ");
  return terminal.name || place || terminal.title || terminal.program?.name || terminal.address || "Parent conversation";
}

export function withLineage(list, context) {
  return list.map(h => ({ ...h, label: h.label || h.desc || "Subagent", owner: context.owner, ownerSession: context.session, rootPath: context.path, parentTitle: context.title,
    machine: h.terminal ? h.machine : context.machine,
    spec: [modelName(h.model), levelName(h.effort)].filter(Boolean).join(" · ") || h.spec,
    children: withLineage(h.children ?? [], { owner: h.terminal ?? context.owner, session: h.terminal ? h.session : context.session,
      path: h.terminal ? h.path : context.path, machine: h.terminal ? h.machine : context.machine, title: h.label || h.desc || "Subagent" }) }));
}
