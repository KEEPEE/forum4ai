/**
 * EN resources = SOURCE OF TRUTH (Phase 2a). Imported EAGERLY, so the
 * first render is never left without text. `sk` (and every further language)
 * is loaded only by a dynamic `import()` in `i18n/index.ts`.
 *
 * The JSON files are the only source of text — no hardcoded string in
 * components (the rule in `docs/skill.md`).
 */
import type { Resource } from 'i18next';

import enAdmin from '../locales/en/admin.json';
import enAuth from '../locales/en/auth.json';
import enCommon from '../locales/en/common.json';
import enForum from '../locales/en/forum.json';
import enPaper from '../locales/en/paper.json';
import enRegister from '../locales/en/register.json';
import enSettings from '../locales/en/settings.json';
import enWrite from '../locales/en/write.json';

/** EN zbalené v bundle (statický import — žiadny request, žiadny chunk navyše) */
export const enResources: Resource = {
  en: {
    common: enCommon,
    forum: enForum,
    write: enWrite,
    auth: enAuth,
    admin: enAdmin,
    settings: enSettings,
    register: enRegister,
    paper: enPaper,
  },
};

/**
 * Lazy loader ostatných jazykov. Cesta MUSÍ byť template literal s
 * pevným prefixom/suffixom — Vite z neho urobí glob a každý súbor
 * dostane vlastný chunk (SK preto NIE JE v main bundle).
 *
 * Build pri tom hlási 7x „en/<ns>.json is dynamically imported but also
 * statically imported — dynamic import will not move module into another
 * chunk“. To je presne to, čo chceme: EN ostáva v hlavnom chunke.
 * Glob cez `../locales/` zahŕňa aj `en/`, lebo i18next volá backend len
 * pre jazyky, ktoré v bundle nie sú (`partialBundledLanguages`), takže
 * EN vetva je mŕtvy kód — warning je informatívny, nie chyba.
 *
 * F4AI-43 note for whoever adds the next language: the glob is built when this
 * file is TRANSFORMED, so a brand-new `locales/<code>/` directory stays
 * invisible until the Vite/Vitest transform cache is dropped
 * (`rm -rf node_modules/.vite*`) — until then the import fails with
 * „Unknown variable dynamic import“ and the language silently renders EN.
 */
export function localeResource(language: string, namespace: string): Promise<Resource> {
  return import(`../locales/${language}/${namespace}.json`);
}
