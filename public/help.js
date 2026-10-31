// "About": the app's own help, the same for every space. It lives here (not in the database)
// so it stays true as the app changes. The group's own text ("About this group") is separate and editable.
import { h } from "./dom.js";
import { QUESTION_STATES, STATE, STATE_HINT } from "./labels.js";
import { statusPill } from "./components.js";

const link = (href, text) => h("a", { href }, text);

/** The help sections, as DOM. `labels` are the space's status labels (`{label, state}`). */
export function helpSections(labels = []) {
  const states = h(
    "ul",
    { class: "help-states" },
    QUESTION_STATES.map((s) => {
      const own = labels.filter((l) => l.state === s && l.label !== STATE[s]).map((l) => l.label);
      return h("li", null, statusPill(s), " ", h("span", { class: "muted" }, STATE_HINT[s], own.length ? ` · also labelled here: ${own.join(", ")}` : ""));
    }),
  );
  return [
    h("h2", null, "What this is for"),
    h("p", null, "A place where a group keeps track of the matters it needs to settle together. A ", h("strong", null, "matter"), " is anything the group needs to look into, decide or follow: a question, a proposal, an experiment, an issue. This isn't where the discussion happens; a matter points to where the work does."),

    h("h2", null, "Adding a matter"),
    h("p", null, "Type a title, or paste a link, in the box at the top of ", link("#/list", "Matters"), ". Suggestions appear as you type, because the matter may already exist. Everything else (kind, status, summary, results, dates) can be filled in now or later. Matters with dates also show on the timeline."),

    h("h2", null, "Attached link"),
    h("p", null, "A matter can have one attached link: a pull request, a poll, a forum thread… or none, for a meeting or a workshop (just give its kind)."),
    h("p", null, "Each field of a matter is either ", h("strong", null, "retrieved"), " from the linked item, for sites on the ", link("#/rules", "Tools"), " list, or ", h("strong", null, "typed"), " by someone. A typed value wins until someone chooses to use the retrieved one again."),

    h("h2", null, "Status"),
    h("p", null, "Every matter is in one of six categories:"),
    states,
    h("p", null, "A retrieved status follows the link: the poll closes, the pull request is merged. Otherwise anyone can type it, choosing one of the space's labels (each belongs to a category; they're on the ", link("#/rules", "Tools"), " page)."),

    h("h2", null, "Related matters"),
    h("p", null, "Matters can be related as parent and child, or as duplicates. The same title or link can't be added twice; when a near-duplicate is spotted, the app suggests marking it as a duplicate and withdrawing it, and people decide."),

    h("h2", null, "Archiving"),
    h("p", null, "A matter added by mistake can be archived: it's hidden from the lists, kept in the history, and can be restored. Nothing is ever deleted."),

    h("h2", null, "Who can do what"),
    h(
      "ul",
      null,
      h("li", null, "Anyone with the ", h("strong", null, "edit link"), " can add and change matters, tools, status labels and the “About this group” text."),
      h("li", null, "Anyone with the ", h("strong", null, "view link"), " can read everything, including the names in ", link("#/activity", "Activity"), ". Share it only with people who should see all of that."),
      h("li", null, "Names aren't verified. Please use the name people know you by."),
      h("li", null, "Every change is recorded in Activity, and the log can't be edited."),
    ),
    h("p", { class: "muted small" }, "Your data and who can see it: ", h("a", { href: "/privacy" }, "privacy notice"), "."),
  ];
}
