import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { active, settled } from "./state.js";
import { conversationTitle } from "./lineage.js";

export function subagentContext(all, core, panes, focus, spaces = []) {
  const owners = core.filter(k => all[k.address]);
  const current = owners.find(k => k.address === (focus?.shown ?? focus?.terminal)
    || (focus?.pane && k.labels?.["herdr.chat"] === focus.pane));
  const owner = current ?? owners.find(k => panes.some(p => p.tab === focus?.tab
    && (p.terminal === k.address || p.pane === k.labels?.["herdr.chat"])));
  return owner ? { owner: owner.address, title: conversationTitle(owner, panes, spaces), entry: all[owner.address] } : null;
}

const labels = { running: "Running", starting: "Starting", pending: "Starting", waiting: "Needs you", completed: "Completed", failed: "Failed", interrupted: "Interrupted", cancelled: "Cancelled", stopped: "Stopped", unavailable: "Unavailable", idle: "Idle" };

export function subagentTree(list, owner, disconnected = false, ancestors = new Set()) {
  return list.flatMap(h => {
    const key = `${h.owner ?? owner}:${h.id}`;
    if (ancestors.has(key)) return [];
    const agent = disconnected && active(h.status) ? { ...h, status: "unavailable" } : h;
    const children = subagentTree(h.children ?? [], h.terminal ?? owner, disconnected, new Set([...ancestors, key]));
    return [{ agent, key, children, size: 1 + children.reduce((n, c) => n + c.size, 0),
      activeCount: Number(active(agent.status)) + children.reduce((n, c) => n + c.activeCount, 0),
      settledCount: Number(settled(agent.status)) + children.reduce((n, c) => n + c.settledCount, 0) }];
  });
}

export function subagentPanel(t, context, open, close, branches = new Map()) {
  const entry = context?.entry;
  const disconnected = ["unavailable", "disconnected"].includes(entry?.connection);
  const list = subagentTree(entry?.list ?? [], context?.owner, disconnected);
  const groups = [["Active", list.filter(h => h.activeCount), "activeCount"],
    ["Previous agents", list.filter(h => h.settledCount === h.size).reverse(), "settledCount"],
    ["Other agents", list.filter(h => !h.activeCount && h.settledCount !== h.size), "size"]];
  const row = node => {
    const h = node.agent, expanded = branches.get(node.key) ?? node.activeCount > 0;
    return v_flex().flex_none()
      .child(v_flex().id(`subagent-${node.key}`).flex_none().px(10).py(9).gap(5).rounded(8).cursor_pointer()
    .hover(s => s.bg(t.hover)).tooltip(h.label).on_click(() => open(h))
    .child(h_flex().gap(8).items_start()
      .child(div().w(14).h(18).flex_none().when(node.children.length > 0, el => el.id(`subagent-fold-${node.key}`)
        .tooltip(`${expanded ? "Collapse" : "Expand"} ${node.size - 1} subagents`).on_click((_e, cx) => { cx.stop_propagation(); branches.set(node.key, !expanded); cx.notify(); })
        .child(svg(`mods/workspace-chrome/chevron-${expanded ? "down" : "right"}.svg`).size(12))))
      .child(image(`icons/${h.provider ?? entry.kind}.svg`).w(14).h(14).mt(2).flex_none())
      .child(div().flex_1().min_w(0).font_medium().child(h.label)))
    .child(h_flex().pl(44).gap(8).items_center().text_size(11.5)
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(h.spec || (h.provider === "codex" ? "Codex" : "Claude Code")))
      .child(div().flex_none().text_color(h.status === "waiting" || h.status === "failed" ? t.blocked : active(h.status) ? t.working : t.muted)
        .child(h.status === "waiting" && h.waitingReason === "api_limit" ? "Waiting · API limit" : labels[h.status] ?? "Unknown"))))
      .when(expanded && node.children.length > 0, el => el.child(v_flex().flex_none().ml(16).pl(6).border_l(1).border_color(t.border).children(node.children.map(row))));
  };
  return v_flex().id("subagents-panel").size_full().min_h(0).rounded(10).overflow_hidden()
    .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
    .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg("mods/chat/subagents.svg").size(14).text_color(t.muted))
      .child(div().flex_1().font_semibold().child("Subagents"))
      .child(div().id("subagents-close").p(4).rounded(5).cursor_pointer().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Close Subagents").on_click(close).child(svg("mods/chat/x.svg").size(12))))
    .when(Boolean(context), el => el.child(div().flex_none().px(14).py(10).truncate().text_color(t.muted).tooltip(context.title).child(context.title)))
    .when(disconnected, el => el.child(div().flex_none().px(14).pb(8).text_size(12).text_color(t.muted).child("Connection unavailable · Showing last known state")))
    .child(v_flex().id(`subagents-list-${context?.owner ?? "empty"}`).flex_1().min_h(0).p(6).overflow_y_scrollbar()
      .when(!list.length, el => el.child(div().p(8).text_color(t.dim).child(context ? "No subagents in this conversation." : "Open an agent chat to see its subagents.")))
      .children(groups.filter(([, rows]) => rows.length).map(([name, rows, count]) => v_flex().flex_none().pb(10)
        .child(div().px(10).pt(6).pb(4).text_size(11.5).text_color(t.dim).child(`${name} · ${rows.reduce((n, node) => n + node[count], 0)}`))
        .children(rows.map(row)))));
}
