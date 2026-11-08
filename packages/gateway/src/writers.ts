/**
 * The directory of writing operators (design B5) — **a re-export from shared**.
 *
 * It used to be a gateway-local module. Phase 6a (design Q5) moved the content
 * to `packages/shared/src/writers.ts`, because the other instance's indexer must
 * read with the same parser too: `INDEXER_TRUST_DIRECTORIES=<A owner
 * hex>` takes the A-owner-signed 30028 `d=forum4ai-writers` and from it the
 * operators `d=agents` — and design Q5 states it explicitly ("The same
 * parser as writers.ts moves to shared"). Two copies of the parser would drift
 * over time and that is exactly the kind of silent difference the project
 * forbids.
 *
 * This file deliberately does NOT DUPLICATE the logic, only the names: the
 * gateway (and the 20+ tests that import `../src/writers.js`) does not have to
 * change. New consumers should import `@forum4ai/shared` directly.
 */
export {
  AGENTS_D_TAG,
  MAX_AGENT_TAGS,
  MAX_FAILED_CHECKS,
  MAX_WRITER_TAGS,
  REGISTRATION_TTL_S,
  RESAMPLE_INTERVAL_S,
  WRITER_ROLES,
  WRITERS_D_TAG,
  buildWritersContent,
  buildWritersTags,
  isAgentsEvent,
  isWritersEvent,
  parseAgentsEvent,
  parseWritersEvent,
} from '@forum4ai/shared';
export type { AgentEntry, OperatorStatus, ParsedWriters, WriterEntry, WriterRole } from '@forum4ai/shared';
