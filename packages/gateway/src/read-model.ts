/**
 * Read-model for S5 (F4AI-11) — purely deterministic functions without I/O:
 * they build the topic tree and the reply tree from events fetched from the pool.
 *
 * Determinism and rules:
 *  - LWW per address `30020:<pubkey>:<slug>`: the newer `created_at` wins;
 *    on an equal `created_at` the lexicographically LOWER id wins — the same
 *    rule as NIP-01 and our `packages/relay` `MemoryStore`.
 *  - topic tree: the parent is an `a` tag with the ancestor's address; root = no
 *    parent. An orphaned topic (the parent does not exist) and the members of a
 *    cycle are moved under the synthetic root `'unsorted'`, each case is
 *    recorded in `issues`.
 *  - ordering: `created_at` asc, then `slug` asc (then `id` asc),
 *    recursively for children; the synthetic `unsorted` is always last.
 *    `applyThreadActivity` switches the order to activity: thread count
 *    (own + in descendants) descending, then newer `created_at` —
 *    hence the optional `thread_count` on nodes (an additive field,
 *    backward compatible with older UI clients).
 *  - NIP-10 root resolution (1023 without a `root` marker): we follow
 *    `parent` markers at most 50 steps; a cycle or an unknown parent →
 *    the root could not be derived (null).
 */
import { THREAD_ROOT_KINDS } from '@forum4ai/shared';
import type { Event } from 'nostr-tools';

/** syntetický koreň pre osirotené/cyklické topicy */
export const UNSORTED_SLUG = 'unsorted';

/** limit hĺbky pri nasledovaní `parent` markerov (NIP-10 resolution) */
export const MAX_PARENT_HOPS = 50;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const ADDRESS_RE = /^30020:[0-9a-f]{64}:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** Uzol stromu topicov. `address: null` má len syntetický `unsorted` uzol. */
export interface TopicNode {
  slug: string;
  address: string | null;
  pubkey: string | null;
  event_id: string | null;
  created_at: number;
  content: string;
  /** adresa rodiča (`a` tag) alebo null (koreň / unsorted) */
  parent: string | null;
  children: TopicNode[];
  /**
   * Počet nití v podstromi (vlastné nite s `a` tagom na adresu uzla
   * + všetky descendants).
   * Plní ho `applyThreadActivity`; uzol bez tohto pole nemá počítanú
   * aktivitu (napr. strom postavený len `buildTopicTree`). Syntetický
   * `unsorted` súčte deti. Additívne pole — starší konzumenti ho ignorujú.
   */
  thread_count?: number;
}

export interface TopicTree {
  /** koreňové uzly zotriedené; syntetický `unsorted` je posledný (ak existuje) */
  roots: TopicNode[];
  /** počet unikátnych topicov po LWW deduplikácii */
  topic_count: number;
  /** diagnostika: osirotené parenty, cykly */
  issues: string[];
}

/** Uzol stromu odpovedí — kánonické polia eventu + parent + deti. */
export interface ReplyNode {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
  /** id rodiča (root id pre priame odpovede) */
  parent: string;
  children: ReplyNode[];
}

export interface ReplyTree {
  root: ReplyNode;
  /** všetky zaradené odpovede (mimo rootu) */
  replies: ReplyNode[];
  issues: string[];
}

// ── pomocníky tagov ───────────────────────────────────────────────────────

export function topicSlug(event: Event): string | null {
  const d = event.tags.find((tag) => tag[0] === 'd');
  const slug = d?.[1];
  return slug !== undefined && SLUG_RE.test(slug) ? slug : null;
}

/** adresa `30020:<pubkey>:<slug>` topicu, alebo null ak event nemá platný d-tag */
export function topicAddress(event: Event): string | null {
  const slug = topicSlug(event);
  return slug === null ? null : `30020:${event.pubkey}:${slug}`;
}

/** adresa rodičovského topicu z `a` tagu; neplatná forma → null (berieme ako koreň) */
export function topicParentAddress(event: Event): string | null {
  const a = event.tags.find((tag) => tag[0] === 'a');
  const addr = a?.[1];
  return addr !== undefined && ADDRESS_RE.test(addr) ? addr : null;
}

/** id z `e` tagu s markerom `root` (NIP-10), alebo null */
export function rootMarkerId(event: Event): string | null {
  const e = event.tags.find((tag) => tag[0] === 'e' && tag[2] === 'root');
  return e?.[1] ?? null;
}

/** id z `e` tagu s markerom `parent` (NIP-10), alebo null */
export function parentMarkerId(event: Event): string | null {
  const e = event.tags.find((tag) => tag[0] === 'e' && tag[2] === 'parent');
  return e?.[1] ?? null;
}

// ── LWW deduplikácia ──────────────────────────────────────────────────────

/**
 * LWW per adresa `kind:pubkey:d`. Novší `created_at` vyhráva; pri rovnosti
 * vyhráva lexikograficky nižšie id (NIP-01, zhodné s naším relay MemoryStore).
 * Eventy bez platného d-tagu preskočíme.
 */
export function lwwByAddress(events: Event[]): Map<string, Event> {
  const map = new Map<string, Event>();
  for (const event of events) {
    const address = topicAddress(event);
    if (address === null) continue;
    const current = map.get(address);
    if (
      current === undefined ||
      event.created_at > current.created_at ||
      (event.created_at === current.created_at && event.id < current.id)
    ) {
      map.set(address, event);
    }
  }
  return map;
}

// ── strom topicov ─────────────────────────────────────────────────────────

function compareTopicNodes(a: TopicNode, b: TopicNode): number {
  return (
    a.created_at - b.created_at ||
    (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : (a.event_id ?? '') < (b.event_id ?? '') ? -1 : (a.event_id ?? '') > (b.event_id ?? '') ? 1 : 0)
  );
}

function sortTopicChildren(nodes: TopicNode[], issues: string[], seen: Set<string>): void {
  nodes.sort(compareTopicNodes);
  for (const node of nodes) {
    if (node.address !== null) {
      if (seen.has(node.address)) {
        issues.push(`duplicate node in the tree: ${node.address}`);
        node.children = [];
        continue;
      }
      seen.add(node.address);
    }
    sortTopicChildren(node.children, issues, seen);
  }
}

/**
 * Zostaví strom topicov z 30020 eventov.
 *
 * 1. LWW deduplikácia per adresa,
 * 2. deti podľa `a` parent adresy,
 * 3. cykly v parent retazcoch (aj seba-rodič) detekujeme pri prehliadke
 *    retazca — členovia cyklu sa presunú pod `unsorted`,
 * 4. osirotené topicy (parent adresa neexistuje v množine) idú tiež pod
 *    `unsorted`; každý prípad evidujeme v `issues`.
 */
export function buildTopicTree(events: Event[]): TopicTree {
  const lww = lwwByAddress(events);
  const issues: string[] = [];

  const nodes = new Map<string, TopicNode>();
  for (const [address, event] of lww) {
    nodes.set(address, {
      slug: topicSlug(event) as string,
      address,
      pubkey: event.pubkey,
      event_id: event.id,
      created_at: event.created_at,
      content: event.content,
      parent: topicParentAddress(event),
      children: [],
    });
  }

  // ── detekcia cyklov: chádzka parent retazcom so sledovanou cestou ──
  const state = new Map<string, 'done'>();
  const inCycle = new Set<string>();
  const walk = (address: string, path: string[]): void => {
    if (state.get(address) === 'done') return;
    const at = path.indexOf(address);
    if (at >= 0) {
      const cycle = path.slice(at);
      for (const a of cycle) inCycle.add(a);
      issues.push(`parent address cycle: ${[...cycle, address].join(' -> ')}`);
      return;
    }
    path.push(address);
    const parent = nodes.get(address)?.parent ?? null;
    if (parent !== null && nodes.has(parent)) walk(parent, path);
    path.pop();
    state.set(address, 'done');
  };
  for (const address of nodes.keys()) walk(address, []);

  // ── priradenie detí ──
  const roots: TopicNode[] = [];
  const unsortedChildren: TopicNode[] = [];
  for (const [address, node] of nodes) {
    if (node.parent === null) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(node.parent);
    if (parent !== undefined && !inCycle.has(node.parent)) {
      parent.children.push(node);
    } else if (parent === undefined) {
      issues.push(`orphan topic ${node.slug}: parent ${node.parent} does not exist`);
      unsortedChildren.push(node);
    } else {
      // uzol je člen cyklu, alebo visí na cyklickom rodičovi — pod unsorted
      issues.push(
        inCycle.has(address)
          ? `topic ${node.slug} is part of a cycle: parent ${node.parent}`
          : `topic ${node.slug} hangs on a cyclic branch: parent ${node.parent}`,
      );
      unsortedChildren.push(node);
    }
  }

  // ── usporiadanie ──
  sortTopicChildren(roots, issues, new Set<string>());
  sortTopicChildren(unsortedChildren, issues, new Set<string>());

  const topic_count = nodes.size;
  if (unsortedChildren.length > 0) {
    const minCreated = unsortedChildren.reduce(
      (min, node) => Math.min(min, node.created_at),
      unsortedChildren[0]?.created_at ?? 0,
    );
    roots.push({
      slug: UNSORTED_SLUG,
      address: null,
      pubkey: null,
      event_id: null,
      created_at: minCreated,
      content: '',
      parent: null,
      children: unsortedChildren,
    });
  }
  // unsorted je vždy posledný — statické poradie po zotriedení reálnych koreňov
  const realRoots = roots.filter((node) => node.address !== null);
  const unsorted = roots.filter((node) => node.address === null);
  realRoots.sort(compareTopicNodes);

  return { roots: [...realRoots, ...unsorted], topic_count, issues };
}

// ── aktivita topicov (počty nití + ordering) ─────────────────────────────

/**
 * Spočíta nite per adresa topicu z koreňových eventov (1020/1021/1022).
 * Nite viaž na topik `a` tagom na adresu `30020:<pubkey>:<slug>` — berieme
 * LEN validné adresy (rovnaké ADDRESS_RE ako pri parentoch) a jeden event
 * započítame per unikátna adresa (event môže referencovať viac topicov,
 * duplicitné `a` tagy nepočítame dvakrát).
 */
export function countThreadsByTopicAddress(threadEvents: Event[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of threadEvents) {
    const counted = new Set<string>();
    for (const tag of event.tags) {
      if (tag[0] !== 'a') continue;
      const address = tag[1];
      if (address === undefined || !ADDRESS_RE.test(address) || counted.has(address)) continue;
      counted.add(address);
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Activity usporiadanie: viac nití (vlastných + descendants) vyššie, pri
 * rovnakom počte novší `created_at`, potom `slug`/`event_id` asc
 * (deterministický tiebreak aj pri zhode času).
 */
function compareTopicActivity(a: TopicNode, b: TopicNode): number {
  const countDiff = (b.thread_count ?? 0) - (a.thread_count ?? 0);
  if (countDiff !== 0) return countDiff;
  const timeDiff = b.created_at - a.created_at;
  if (timeDiff !== 0) return timeDiff;
  if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
  const aId = a.event_id ?? '';
  const bId = b.event_id ?? '';
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * Anotuje strom počtami nití a preusporiada korene aj deti podľa aktivity
 * (`compareTopicActivity`). `thread_count` uzla = vlastné nite + súčet
 * detí (rekurzívne, descendants započítané). Syntetický `unsorted` ostáva
 * posledný — jeho počet je súčtom detí, ale poradie koreňov ho nesmie
 * dostať pred aktívne reálne korene (invariant `buildTopicTree`).
 *
 * Voliteľné pole: strom, ktorý touto funkciou neprešiel, `thread_count`
 * neobsahuje a poradie zostáva created_at asc (pôvodné správanie).
 */
export function applyThreadActivity(tree: TopicTree, counts: ReadonlyMap<string, number>): void {
  const annotate = (node: TopicNode): number => {
    let total = node.address !== null ? (counts.get(node.address) ?? 0) : 0;
    for (const child of node.children) total += annotate(child);
    node.thread_count = total;
    return total;
  };
  const sortChildren = (nodes: TopicNode[]): void => {
    nodes.sort(compareTopicActivity);
    for (const node of nodes) sortChildren(node.children);
  };

  for (const root of tree.roots) annotate(root);
  const realRoots = tree.roots.filter((node) => node.address !== null);
  const unsorted = tree.roots.filter((node) => node.address === null);
  // `sortChildren` zotriedi pole IN PLACE a rekurzívne aj deti — deti
  // reálnych koreňov musia byť zoradené rovnako ako korene samy
  sortChildren(realRoots);
  for (const node of unsorted) sortChildren(node.children);
  tree.roots = [...realRoots, ...unsorted];
}

// ── NIP-10 root resolution ────────────────────────────────────────────────

/**
 * Deterministicky zistí root id 1023 odpovede:
 *  1. `root` marker → jeho hodnota,
 *  2. inak nasledujeme `parent` markery (max. MAX_PARENT_HOPS krokov):
 *     - parent je thread-root kind (1020/1021/1022) → jeho id,
 *     - parent má `root` marker → jeho hodnota,
 *     - parent už nemá `parent` marker → je hlavou retazca → jeho id,
 *     - inak pokračujeme v retazci.
 * Event bez `root` aj `parent` markera je sám sebou (root = vlastné id).
 * Cyklus, neznámy parent alebo prekročenie hĺbky → null (root neviem
 * odvodiť — volajúci takú odpoved do vlákna nezaradí).
 */
export function resolveRootId(event: Event, byId: Map<string, Event>): string | null {
  const direct = rootMarkerId(event);
  if (direct !== null) return direct;

  const seen = new Set<string>([event.id]);
  let current = event;
  for (let hop = 0; hop < MAX_PARENT_HOPS; hop += 1) {
    const parentId = parentMarkerId(current);
    if (parentId === null) return current.id; // hlava retazca — current je root
    if (seen.has(parentId)) return null; // cyklus
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent === undefined) return null; // neznámy parent
    if (THREAD_ROOT_KINDS.has(parent.kind)) return parentId;
    const parentRoot = rootMarkerId(parent);
    if (parentRoot !== null) return parentRoot;
    current = parent;
  }
  return null; // prekročený limit hĺbky
}

// ── strom odpovedí ────────────────────────────────────────────────────────

function toReplyNode(event: Event, parent: string): ReplyNode {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
    parent,
    children: [],
  };
}

function compareReplyNodes(a: ReplyNode, b: ReplyNode): number {
  return a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Efektívny parent odpovede: `parent` marker, ak smeruje do množiny vlákna
 * a jeho retiazka nevytvorí cyklus; inak priamo pod `rootId`. Retiazka sa
 * overuje so sledovanou množinou — zaručí, že výsledný graf je acyklický.
 */
function effectiveParent(
  event: Event,
  rootId: string,
  inThread: Map<string, Event>,
): { parent: string; cycled: boolean } {
  const marker = parentMarkerId(event);
  if (marker === null || marker === event.id || !inThread.has(marker)) {
    return { parent: rootId, cycled: false };
  }
  // sleduj retiazku parent markerov; ak vráti do už videného alebo mimo
  // vlákno, odpoved zavesíme priamo na root (acyklickosť stromu)
  const seen = new Set<string>([event.id]);
  let cursor = marker;
  for (let hop = 0; hop < MAX_PARENT_HOPS; hop += 1) {
    if (cursor === rootId) return { parent: marker, cycled: false };
    if (seen.has(cursor)) return { parent: rootId, cycled: true };
    seen.add(cursor);
    const next = inThread.get(cursor);
    if (next === undefined) return { parent: marker, cycled: false };
    const nextParent = parentMarkerId(next);
    if (nextParent === null) return { parent: marker, cycled: false };
    cursor = nextParent;
  }
  return { parent: rootId, cycled: true };
}

/**
 * Zostaví strom odpovedí pre `rootEvent`. `replies` sú 1023 eventy, ktoré
 * už volajúci vyfiltroval na root (cez `resolveRootId`). Odpoved s
 * `parent` markerom na inú odpoved vo vlákne sa zavesí pod ňu (detekcia
 * cyklov: cyklické odpovede idú priamo pod root a evidujú sa v `issues`);
 * priame odpovedy a odpovedy s neznámym parentom idú pod root.
 * Triedenie detí: `created_at` asc, potom `id` asc.
 */
export function buildReplyTree(rootEvent: Event, replies: Event[]): ReplyTree {
  const issues: string[] = [];
  const inThread = new Map<string, Event>();
  for (const reply of replies) inThread.set(reply.id, reply);

  const root = toReplyNode(rootEvent, '');
  const byId = new Map<string, ReplyNode>([[rootEvent.id, root]]);
  for (const reply of replies) {
    const { parent, cycled } = effectiveParent(reply, rootEvent.id, inThread);
    if (cycled) issues.push(`cycle in the parent chain of reply ${reply.id} — attached directly under the root`);
    byId.set(reply.id, toReplyNode(reply, parent));
  }

  const attached: ReplyNode[] = [];
  for (const [id, node] of byId) {
    if (id === rootEvent.id) continue;
    const parent = byId.get(node.parent) ?? root;
    parent.children.push(node);
    attached.push(node);
  }

  const sortChildren = (node: ReplyNode, seen: Set<string>): void => {
    node.children.sort(compareReplyNodes);
    for (const child of node.children) {
      if (seen.has(child.id)) {
        issues.push(`duplicate reply node ${child.id} — removed from the tree`);
        child.children = [];
        continue;
      }
      seen.add(child.id);
      sortChildren(child, seen);
    }
  };
  sortChildren(root, new Set<string>([rootEvent.id]));

  return { root, replies: attached, issues };
}

// ── feed ──────────────────────────────────────────────────────────────────

/** Posledné príspevky: `created_at` desc, pri rovnosti `id` asc. */
export function sortFeedDesc(events: Event[]): Event[] {
  return [...events].sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
