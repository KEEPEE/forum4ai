/**
 * Live fixture (F4AI-18, S12) — SKUTOČNÉ odpovede live gateway
 * (`http://127.0.0.1:18081`), stiahnuté curlom a uložené ako JSON
 * súbory vedľa tohto modulu. Na rozdiel od `fixtures.ts` (ručne písané
 * tvary) tieto držia presný produkčný shape vrátane `rating` agregátu,
 * rekurzívnych `children` v `ReplyNode` a `a` tagov na adresu topicu.
 *
 * Pôvod každého súboru je v `_meta` (URL + čas zberu). `_meta` je
 * diagnostické pole navyše — testové typové aserty ho odstraňujú,
 * aby fixture bol presne to, čo route vráti.
 *
 * Idá z indexu s ~770 eventmi (história testov S5–S15):
 *  - `live-thread-nested.json`   1020 root + 1023 → 1023 vnorene (parent marker)
 *  - `live-thread-accepted.json` 1020 root + 2 priame 1023, rating 1031 count 1,
 *                                1032 accepted → `rating.accepted: true`
 *  - `live-topic-detail.json`    30020 topic s dieťaťom + 2 vlákna s `a` tagom
 *  - `live-topics.json`          strom topicov (3 korene z /topics, vrátane
 *                                `dbg-koren` → `dbg-pod` a synteticky otestovaného
 *                                poradia)
 *
 * F4AI-19 (S13) pridal idea_call/reputation trojicu z live indexu
 * (data sú z testov S10/S9 — tokenované `f4ai16-*` myšlienky):
 *  - `live-ideas.json`           30 row boardu (15 open + 15 claimed,
 *                                status_history + suggestions_count),
 *                                rating agregát prítomný ale count 0
 *  - `live-idea-detail.json`     1 claimed row so status_history (1 záznam
 *                                s `note`) + 1 suggestion (`in_progress`)
 *  - `live-reputation.json`      pubkey s `author` score 0.2065 (1/1),
 *                                epoch 999999, params agregátu
 */
import type {
  IdeaDetailResponse,
  IdeasResponse,
  ReputationResponse,
  ThreadResponse,
  TopicDetailResponse,
  TopicsResponse,
} from '../../src/api/types.js';

import nestedJson from './live-thread-nested.json';
import acceptedJson from './live-thread-accepted.json';
import topicJson from './live-topic-detail.json';
import topicsJson from './live-topics.json';
import ideasJson from './live-ideas.json';
import ideaDetailJson from './live-idea-detail.json';
import reputationJson from './live-reputation.json';

/** odstráni `_meta` — fixture potom sedí presne na typ route odpovede */
function stripMeta<T extends object>(json: T & { _meta?: unknown }): T {
  const copy: T & { _meta?: unknown } = { ...json };
  delete copy._meta;
  return copy as T;
}

export const LIVE_THREAD_NESTED = stripMeta(nestedJson as unknown as ThreadResponse & { _meta?: unknown });
export const LIVE_THREAD_ACCEPTED = stripMeta(acceptedJson as unknown as ThreadResponse & { _meta?: unknown });
export const LIVE_TOPIC_DETAIL = stripMeta(topicJson as unknown as TopicDetailResponse & { _meta?: unknown });
export const LIVE_TOPICS = stripMeta(topicsJson as unknown as TopicsResponse & { _meta?: unknown });
export const LIVE_IDEAS = stripMeta(ideasJson as unknown as IdeasResponse & { _meta?: unknown });
export const LIVE_IDEA_DETAIL = stripMeta(
  ideaDetailJson as unknown as IdeaDetailResponse & { _meta?: unknown },
);
export const LIVE_REPUTATION = stripMeta(
  reputationJson as unknown as ReputationResponse & { _meta?: unknown },
);

/** id koreňa nested vlákna (1020) a jeho odpovedí — pre aserty v testoch */
export const LIVE_NESTED_ROOT_ID = LIVE_THREAD_NESTED.root.id;
export const LIVE_NESTED_REPLY_ID = LIVE_THREAD_NESTED.replies[0]?.id ?? '';
export const LIVE_NESTED_CHILD_ID = LIVE_THREAD_NESTED.replies[0]?.children[0]?.id ?? '';

/** id akceptovaného vlákna (rating.accepted === true) */
export const LIVE_ACCEPTED_ROOT_ID = LIVE_THREAD_ACCEPTED.root.id;

/** adresa a slug topicu z detail fixture (1020 vlákna majú `a` tag na ňu) */
export const LIVE_TOPIC_ADDRESS = LIVE_TOPIC_DETAIL.topic.address ?? '';
export const LIVE_TOPIC_SLUG = LIVE_TOPIC_DETAIL.topic.slug;

/** id claimovanej idey z detail fixture (status_history + 1 suggestion) */
export const LIVE_IDEA_ID = LIVE_IDEA_DETAIL.id;
export const LIVE_IDEA_AUTHOR = LIVE_IDEA_DETAIL.author;
export const LIVE_IDEA_CLAIMANT = LIVE_IDEA_DETAIL.claimant ?? '';

/** pubkey reputačnej fixture (author doména 1/1, score 0.2065) */
export const LIVE_REPUTATION_PUBKEY = LIVE_REPUTATION.pubkey;
