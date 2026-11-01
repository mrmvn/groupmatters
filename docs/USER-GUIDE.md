# Using the matter register

*One page for the pilot group.*

**What it is.** A shared list of the matters our group wants to answer together. Each matter can say *where* it's being worked on (a pull request, a Loomio poll, a Polis conversation, a meeting…), and shows where it stands.

**What it isn't.** A place to discuss or decide. Discussion and decisions stay where they already happen. The register links to them and follows their progress.

## Getting in

- Open the link you were given. The **edit link** lets you change things; the **view link** is read-only. Keep the edit link within the group.
- The first time, you'll be asked for a **display name**. Use the name people know you by. Names aren't checked.
- It works on a phone. To get an icon on your home screen: **Share → Add to Home Screen** (iPhone, Safari) or **⋮ → Add to Home screen / Install app** (Android, Chrome). Do it from the link you use: the icon opens that space with that link, so treat the phone as holding it. Several spaces can each have their own icon.

## Statuses

Every matter is in one of six categories: **Not started**, **In progress**, **Accepted**, **Rejected**, **Concluded** (ended without a yes or no) or **Withdrawn**.

- A matter linked to a tool the register can read has its status **retrieved**: when the Loomio poll closes or the pull request is merged, it changes by itself.
- Anyone can **type** a status instead, picking one of the group's status labels, like *Being discussed* or *Agreed*. "↺ use retrieved" goes back.

**Around the page.** There are no tabs: the page opens on the box for adding a matter, then the matters. The **space name** (top left) always brings you back to the matters. The **Menu** (top right) has the **Dashboard**, **Tools**, **Activity**, **About** and **Export** (downloads everything as JSON). The two symbols left of the search switch the items between a **list** (bulleted lines, the default) and a **timeline** (staggered bars), keeping the same search and filters.

The lanes, below the search: **Current** (not started and in progress), **Ended** (accepted, rejected, concluded) and **All** (every matter that isn't archived), each with its count, plus **Archived** when there are any. Withdrawn matters: **Filters → Status → Withdrawn**. In **Filters**, **Status**, **Tool** and **Item type** are drop-downs of boxes: tick several to see matters that match any of them (for instance GitHub *or* Loomio). **Tool → No tool** shows the matters with no tool attached. Cards marked **★ Changed since your last visit** have news. The list is ordered by latest activity, including activity on the linked platform.

## Adding a matter

Type in the box at the top: **"Name or link your process"** You can also **drag a link** from another tab anywhere onto the page; on a matter without a process, a dropped link becomes its process.

- **Typing a matter**: similar existing matters appear below. Check them first, then press *Add matter*.
- **Pasting a link** (a GitHub pull request, a Loomio poll, a Polis conversation…): the register recognises the tool and fills in the retrieved title. Keep it to follow the item's title, or rewrite it in your own words (it's then typed).
- **A link from a site not on the tool list** works too: nothing is retrieved, so you type the title and the rest. You can **add the tool** (see Tools below), and the link starts being retrieved.

Once you've typed a title or pasted a link, the **Details** (kind, status, summary, results, start, end) appear below, all optional. For a link the register can read, they are **pre-filled with what it retrieves** (tagged "retrieved") and keep following the item; change one to type your own. Without a link, fill what you know now; everything can be changed on the matter's page. *Results* takes a link or a few words ("Adopted 9–1").

## Processes

On a matter's page, the **Attached link** section (**Add an attached link…**) takes a link. As soon as you paste it, the form says whether its site is on the tool list and what would be retrieved:

- **A link.** From GitHub, GitLab, public Loomio polls and threads, Polis, Decidim (any instance) or Consul (once your instance is added under Tools), everything is retrieved: title, status, results, dates, last activity. From Kialo, your own tools or private items, only the kind and title. From any other site, nothing. The ↗ next to a process opens it.
- **What it changes.** Values you typed stay: the retrieved value is listed as "not applied", and ↺ use retrieved on the matter applies it. The exceptions: the kind and the status follow the item (a status you never chose, "Not started", counts as unset), and **replacing** a link removes the typed summary and results link that described the old one.
- **No link**: a meeting, an unconference, a paper survey… Type its **Kind** under **Details**; that is enough.

## Retrieved or typed

Under **Details**, each value says where it comes from: **retrieved** (from the linked item, kept up to date; for a status, *retrieved as “merged”* shows the platform's own word) or **typed** (hover to see by whom and when). **Double-click a value** (or press ✎) to type your own. While a typed value is in use, the retrieved one is shown below it with **↺ use retrieved** to go back. The title works the same way, at the top of the page.

## Dates

**Start** and **End** are fields like the others: retrieved when the item gives them (a poll's opening and closing, a pull request's opening and merge), or typed (leave the time empty for the whole day). "No date" hides a retrieved one. An end in the future is a planned end.

## Dashboard

Open **Menu → Dashboard**: widgets of fixed sizes that fit together (at a glance, matters by status, top tools, kinds of item, what needs attention, momentum over 12 weeks, recently answered). They're prototypes: **Choose widgets** (or **Hide** on a widget) removes the ones you don't find useful, kept in your browser only; the others move up to fill the gap. There are no individual rankings: display names aren't verified.

## Timeline

The **timeline** view (second symbol, next to the lanes; it opens on **All**) shows the matters that have a start date, each as a bar from its start to its end. Running matters reach today (dashed right edge); a planned end shows as a dashed outline; an ended matter with no end date shows a short fading mark. Colours are the status categories, and a vertical line marks today. Hover a bar for its dates. A matter with no start date but a planned end still to come is drawn as if it started today (dashed outline; its tooltip says so). Other matters without a start date are counted below the chart. The search, shortcuts and filters are the same as the list's, and the two symbols switch between the views with the same filters.

## Related matters

On a matter's page, the **Related matters** box lists every matter linked to it, each with how it relates: **Parent**, **Child**, **Related**, **This is a duplicate of** or **Duplicated by**. Relations show on both matters, each from its own side.

To add one, first say what this matter is ("is related to", "is a child of", "is the parent of", "is a duplicate of", "is duplicated by"), then type in the box: matching matters appear, and clicking one links it. If none fits, add yours as a new matter with that relation. "Unlink" removes a relation; both matters stay.

- **Parents and children**: a matter can have several parents, but never be its own ancestor: a link that would close a loop is refused, with the chain that explains why.
- **In the list and on the timeline**, children are shown under their parent, offset with a small branch (for a matter with several parents, under the one linked first that is shown). A **duplicate** is shown the same way under its original, with a dashed branch and a "≡ duplicate" tag. **Related** matters (in the list) are kept next to each other, joined by a dotted line. Whatever the layout shows isn't repeated on the card; the rest is written on it ("Child of…", "Related to…"), for instance when the other matter isn't shown (another lane, a search) or is at another level. **Filters → Children → Listed apart** gives the plain list.
- **Duplicates**: when two matters duplicate each other's purpose, mark one as a duplicate of the other. The page then suggests **withdrawing** the duplicate so only one stays active (a single click; it's never done for you).

## Shortcuts

The dashboard's **Needs attention** widget links to the matters that need a nudge: current matters with no tool attached, matters in progress but quiet for 30+ days (here or on the platform), and links that couldn't be read. The list then says what it shows, with a **clear** link.

## Tools

**Menu → Tools** shows the list of tools and the status labels . Each tool says **what it's useful for** and how many matters use it (click the count to see them); custom tools in use are listed by kind. Anyone with edit access can **add or edit a tool** (the links it recognises; for tools read automatically, only the name and description), and edit the **status labels** (each belongs to one category).

## About

**Menu → About** has two parts. **About this group** is the group's own text: who you are and how you use this space. Anyone with edit access can write or change it (Markdown works; it's hidden from viewers while empty). Below it is the app's own help, the same for every space.

## Good to know

- Everything that changes is recorded in **Activity**, and that record can't be edited.
- The same matter (same title, ignoring case and punctuation) or the same link can't be added twice: the register points you to the existing one.
- **Archive…** hides a matter added by mistake (spam, test) or no longer relevant. It's kept and can be restored from the **Archived** lane of the matters page. On the matter's page, use the **⋯** menu → **Archive…**. For a matter that was dropped or didn't run its course, set a *Withdrawn* status instead, so it stays visible.
