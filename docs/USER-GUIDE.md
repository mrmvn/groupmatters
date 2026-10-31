# Using the question register

*One page for the pilot group.*

**What it is.** A shared list of the questions our group wants to answer together. Each question can say *where* it's being worked on (a pull request, a Loomio poll, a Polis conversation, a meeting…), and shows where it stands.

**What it isn't.** A place to discuss or decide. Discussion and decisions stay where they already happen. The register links to them and follows their progress.

## Getting in

- Open the link you were given. The **edit link** lets you change things; the **view link** is read-only. Keep the edit link within the group.
- The first time, you'll be asked for a **display name**. Use the name people know you by. Names aren't checked.
- It works on a phone. You can add the page to your home screen.

## Statuses

Every question is in one of six categories: **Not started**, **In progress**, **Accepted**, **Rejected**, **Concluded** (ended without a yes or no) or **Withdrawn**.

- A question linked to a tool the register can read has its status **retrieved**: when the Loomio poll closes or the pull request is merged, it changes by itself.
- Anyone can **type** a status instead, picking one of the group's status labels, like *Being discussed* or *Agreed*. "↺ use retrieved" goes back.

**Around the page.** There are no tabs: the page opens on the box for adding an item, then the items. The **space name** (top left) always brings you back to the items. The **Menu** (top right) has the **Dashboard**, **Tools**, **Activity**, **How this works** (the charter) and **Export** (downloads everything as JSON). The two symbols next to the lanes switch the items between a **list** (the default) and a **timeline**, keeping the same search and filters.

The lanes, to the right of the search: **Current** (not started and in progress), **Ended** (accepted, rejected, concluded) and **All**, each with its count. Withdrawn questions: **Filters → Status → Withdrawn**. The shortcuts (no process yet, quiet for 30+ days, fetch problems) are also under **Filters**. Cards marked **★ Changed since your last visit** have news. The list is ordered by latest activity, including activity on the linked platform.

## Adding an item

Type in the box at the top: **"Name or link your process"** You can also **drag a link** from another tab anywhere onto the page; on a question without a process, a dropped link becomes its process.

- **Typing a question**: similar existing questions appear below. Check them first, then press *Add question*.
- **Pasting a link** (a GitHub pull request, a Loomio poll, a Polis conversation…): the register recognises the tool and fills in the retrieved title. Keep it to follow the item's title, or rewrite it in your own words (it's then typed).
- **A link from a site not on the tool list** works too: nothing is retrieved, so you type the title and the rest. You can **add the tool** (see Tools below), and the link starts being retrieved.

Once you've typed a title or pasted a link, the **Details** (kind, status, summary, results, start, end) appear below, all optional. For a link the register can read, they are **pre-filled with what it retrieves** (tagged "retrieved") and keep following the item; change one to type your own. Without a link, fill what you know now; everything can be changed on the question's page. *Results* takes a link or a few words ("Adopted 9–1").

## Processes

On a question's page, the **Attached link** section (**Add an attached link…**) offers two choices:

- **A link.** From GitHub, GitLab, public Loomio polls and threads, Polis, Decidim (any instance) or Consul (once your instance is added under Tools), everything is retrieved: title, status, results, dates, last activity. From Kialo, your own tools or private items, only the kind and title. From any other site, nothing. The ↗ next to a process opens it.
- **No link**: a meeting, an unconference, a paper survey… Give its kind.

## Retrieved or typed

Under **Details**, each value says where it comes from: **retrieved** (from the linked item, kept up to date; for a status, *retrieved as “merged”* shows the platform's own word) or **typed** (hover to see by whom and when). **Double-click a value** (or press ✎) to type your own. While a typed value is in use, the retrieved one is shown below it with **↺ use retrieved** to go back. The title works the same way, at the top of the page.

## Dates

**Start** and **End** are fields like the others: retrieved when the item gives them (a poll's opening and closing, a pull request's opening and merge), or typed (leave the time empty for the whole day). "No date" hides a retrieved one. An end in the future is a planned end.

## Dashboard

Open **Menu → Dashboard**: widgets of fixed sizes that fit together (at a glance, your impact, questions by status, top tools, momentum over 12 weeks with the weekly streak, recently answered, kinds of item, what needs attention, milestones). They're prototypes: **Choose widgets** (or **Hide** on a widget) removes the ones you don't find useful, kept in your browser only; the others move up to fill the gap. "Your impact" goes by display name, which isn't verified.

## Timeline

The **timeline** view (second symbol, next to the lanes; it opens on **All**) shows the questions that have a start date, each as a bar from its start to its end. Running questions reach today (dashed right edge); a planned end shows as a dashed outline; an ended question with no end date shows a short fading mark. Colours are the status categories, and a vertical line marks today. Hover a bar for its dates. Questions without a start date are counted below the chart. The search, shortcuts and filters are the same as the list's, and the two symbols switch between the views with the same filters.

## Related questions

On a question's page, the **Related questions** box lists every question linked to it, each with how it relates: **Parent**, **Child**, **Related**, **This is a duplicate of** or **Duplicated by**. Relations show on both questions, each from its own side.

To add one, first say what this question is ("is related to", "is a child of", "is the parent of", "is a duplicate of", "is duplicated by"), then type in the box: matching questions appear, and clicking one links it. If none fits, add yours as a new question with that relation. "Unlink" removes a relation; both questions stay.

- **Parents and children**: a question can have several parents, but never be its own ancestor: a link that would close a loop is refused, with the chain that explains why.
- **In the list and on the timeline**, children are shown under their parent, offset with a small branch (for a question with several parents, under the one linked first that is shown). A **duplicate** is shown the same way under its original, with a dashed branch and a "≡ duplicate" tag. **Related** questions (in the list) are kept next to each other, joined by a dotted line. Whatever the layout shows isn't repeated on the card; the rest is written on it ("Child of…", "Related to…"), for instance when the other question isn't shown (another lane, a search) or is at another level. **Filters → Children → Listed apart** gives the plain list.
- **Duplicates**: when two questions duplicate each other's purpose, mark one as a duplicate of the other. The page then suggests **withdrawing** the duplicate so only one stays active (a single click; it's never done for you).

## Shortcuts

- **No process yet**: current questions not linked to anything.
- **Quiet for 30+ days**: in progress, but nothing has happened for a month, here or on the platform.
- **Fetch problems**: links that couldn't be read.

## Tools

**Menu → Tools** shows the list of tools and the status labels (the charter is under **Menu → How this works**). Each tool says **what it's useful for** and how many questions use it (click the count to see them); custom processes in use are listed by kind. Anyone with edit access can **add or edit a tool** (the links it recognises; for tools read automatically, only the name and description), and edit the **status labels** (each belongs to one category). The charter is changed by whoever runs the register, for now.

## Good to know

- Everything that changes is recorded in **Activity**, and that record can't be edited.
- The same question (same title, ignoring case and punctuation) or the same link can't be added twice: the register points you to the existing one.
- **Remove…** hides a question added by mistake (spam, test). It's kept and can be restored from the Tools page. For a question that was dropped or didn't run its course, set a *Withdrawn* status instead, so it stays visible.
