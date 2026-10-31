// Adapter registry. Adapters are code; a space can only enable auto tools whose adapter exists here.
import type { Adapter } from "./common.ts";
import { github } from "./github.ts";
import { gitlab } from "./gitlab.ts";
import { loomio } from "./loomio.ts";
import { decidim } from "./decidim.ts";
import { consul } from "./consul.ts";
import { metaculus } from "./metaculus.ts";
import { polis } from "./polis.ts";
import { opavote } from "./opavote.ts";

export type { Adapter, Parsed, FetchResult } from "./common.ts";
export { AdapterError } from "./common.ts";

const ADAPTERS: Record<string, Adapter> = { github, gitlab, loomio, polis, metaculus, decidim, consul, opavote };

export const getAdapter = (id: string): Adapter | undefined => ADAPTERS[id];
export const adapterIds = () => Object.keys(ADAPTERS);
