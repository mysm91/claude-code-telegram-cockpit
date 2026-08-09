// The Agent SDK's query(), behind one injectable seam so every caller (managed sessions, the
// model-catalog probe, the usage warm-up ping) can be driven by the fake-SDK test harness.
import { query } from "@anthropic-ai/claude-agent-sdk";

type QueryFn = typeof query;
let _query: QueryFn = query;

/** The query() implementation to use. Always call through this, never import query directly. */
export function sdkQuery(): QueryFn { return _query; }

/** Test-only: swap in a fake query(); pass null to restore the real implementation. */
export function __setQueryForTests(fn: QueryFn | null): void { _query = fn ?? query; }
