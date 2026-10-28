import { FILTERS } from "./constants.ts";
import { gitDiff } from "./filters/gitDiff.ts";
import { gitStatus } from "./filters/gitStatus.ts";
import { gitLog } from "./filters/gitLog.ts";
import { grep } from "./filters/grep.ts";
import { find } from "./filters/find.ts";
import { dedupLog } from "./filters/dedupLog.ts";
import { ls } from "./filters/ls.ts";
import { tree } from "./filters/tree.ts";
import { smartTruncate } from "./filters/smartTruncate.ts";
import { readNumbered } from "./filters/readNumbered.ts";
import { searchList } from "./filters/searchList.ts";

const REGISTRY = {
  [FILTERS.GIT_DIFF]: gitDiff,
  [FILTERS.GIT_STATUS]: gitStatus,
  [FILTERS.GIT_LOG]: gitLog,
  [FILTERS.GREP]: grep,
  [FILTERS.FIND]: find,
  [FILTERS.DEDUP_LOG]: dedupLog,
  [FILTERS.LS]: ls,
  [FILTERS.TREE]: tree,
  [FILTERS.SMART_TRUNCATE]: smartTruncate,
  [FILTERS.READ_NUMBERED]: readNumbered,
  [FILTERS.SEARCH_LIST]: searchList
};

// Rust resolve_filter aliases (pipe_cmd.rs): grep|rg, find|fd
const ALIASES = {
  rg: grep,
  fd: find
};

export function resolveFilter(name) {
  return REGISTRY[name] || ALIASES[name] || null;
}

export function allFilters() {
  return REGISTRY;
}
