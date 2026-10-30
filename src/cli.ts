// Operator CLI. Usage: node src/cli.ts <command> [...args]
import { loadConfig, type Ctx } from "./ctx.ts";
import { openDb } from "./db.ts";
import * as repo from "./repo.ts";
import { createSpace, rotateLink, spaceLink } from "./spaces.ts";
import { seedDemo } from "./demo.ts";
import { exportSpace } from "./export.ts";

const USAGE = `Question register — operator commands

  create-space "<name>"            Create a space; prints its edit and view links (shown once)
  create-demo                      Create a demo space with example questions
  list-spaces                      List spaces (ids and names; never links)
  rotate-link <space-id> edit|view Invalidate a link and print its replacement
  export <space-id>                Print the space's JSON export

Environment: DB_PATH (default data/register.sqlite), PUBLIC_URL (used to print links).`;

const config = loadConfig();
const ctx: Ctx = { db: openDb(config.dbPath), now: () => new Date(), fetch: (u, i) => fetch(u, i), config };
const [cmd, ...args] = process.argv.slice(2);

function printLinks(name: string, id: string, edit: string, view: string) {
  console.log(`Space "${name}" created (id ${id}).

  Edit link (anyone with it can change things):
    ${spaceLink(ctx, edit)}

  View link (read-only):
    ${spaceLink(ctx, view)}

These links are shown only once. Store them somewhere safe.`);
}

switch (cmd) {
  case "create-space": {
    if (!args[0]) {
      console.error('Usage: create-space "<name>"');
      process.exit(1);
    }
    const r = createSpace(ctx, args.join(" "));
    printLinks(r.space.name, r.space.id, r.editToken, r.viewToken);
    break;
  }
  case "create-demo": {
    const r = await seedDemo(ctx);
    printLinks(r.space.name, r.space.id, r.editToken, r.viewToken);
    break;
  }
  case "list-spaces":
    for (const s of repo.listSpaces(ctx.db)) console.log(`${s.id}\t${s.created_at}\t${s.name}`);
    break;
  case "rotate-link": {
    const [id, which] = args;
    if (!id || (which !== "edit" && which !== "view")) {
      console.error("Usage: rotate-link <space-id> edit|view");
      process.exit(1);
    }
    const token = rotateLink(ctx, id, which);
    console.log(`New ${which} link (the old one no longer works):\n  ${spaceLink(ctx, token)}`);
    break;
  }
  case "export": {
    const s = args[0] && repo.getSpace(ctx.db, args[0]);
    if (!s) {
      console.error("Usage: export <space-id>");
      process.exit(1);
    }
    console.log(JSON.stringify(exportSpace(ctx, s), null, 2));
    break;
  }
  default:
    console.log(USAGE);
    if (cmd && cmd !== "help") process.exit(1);
}
ctx.db.close();
